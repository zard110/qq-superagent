"""Manage independent worker processes in one group's Linux container."""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path('/tmp/qq-agents')
ROOT.mkdir(mode=0o700, exist_ok=True)


def save(path, value):
    tmp = path.with_suffix('.next')
    tmp.write_text(json.dumps(value, ensure_ascii=False))
    tmp.replace(path)


def children(pid):
    try:
        return [int(x) for x in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
    except FileNotFoundError:
        return []


def kill_tree(pid):
    # This supervisor adopts orphaned descendants, including detached SDK shell jobs.
    for child in children(pid):
        kill_tree(child)
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


def live(state):
    try:
        fields = Path(f"/proc/{state['pid']}/stat").read_text().rsplit(')', 1)[1].split()
        return fields[0] != 'Z' and fields[19] == state['birth']
    except FileNotFoundError:
        return False


def supervise(folder):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError('Cannot supervise worker descendants')
    # The parent publishes our PID identity before we may publish progress.
    with (ROOT / '.registry').open('a') as registry:
        fcntl.flock(registry, fcntl.LOCK_SH)
        state = json.loads((folder / 'state').read_text())
    job = json.load(sys.stdin)
    ticket, run = job['ticket'], job['run']
    workspace = Path('/work/tasks') / ticket
    workspace.mkdir(exist_ok=True, parents=True)
    token_file = ROOT / ('lease-' + str(os.getpid()))
    token_file.write_text(job['token'])
    result = {'interrupted': '任务进程已中断'}
    try:
        with tempfile.TemporaryFile(dir=workspace) as inp, tempfile.TemporaryFile(dir=workspace) as out:
            inp.write(json.dumps(job,ensure_ascii=False).encode())
            inp.seek(0)
            env = {**os.environ, 'QQ_TASK_TOKEN':job['token']}
            worker = subprocess.Popen(['node','/opt/harness/worker.mjs'], stdin=inp, stdout=out,
                                      stderr=subprocess.PIPE, env=env, start_new_session=True)
            with selectors.DefaultSelector() as sel:
                sel.register(worker.stderr, selectors.EVENT_READ)
                pending = b''
                while worker.poll() is None:
                    if (folder / 'cancel').exists():
                        result = {'error': '任务已停止'}
                        break
                    if time.time()*1000-state['at'] >= 480000:
                        raise RuntimeError('任务长时间无进展')
                    for _, _mask in sel.select(0.3):
                        chunk = os.read(worker.stderr.fileno(), 65536)
                        if not chunk:
                            sel.unregister(worker.stderr)
                            continue
                        lines = (pending + chunk).split(b'\n')
                        pending = lines.pop()[-2000:]
                        for line in lines:
                            try:
                                step = json.loads(line).get('step')
                            except (ValueError, UnicodeError):
                                continue
                            if isinstance(step,str):
                                state.update(at=int(time.time()*1000),step=step[:120])
                                save(folder/'state',state)
            worker.stderr.close()
            if worker.returncode == 0:
                out.seek(0)
                if (workspace / ('.receipt-'+run)).is_file():
                    result = {'receipt': True}
                else:
                    result = json.loads(out.read(65536))
    except Exception as error:
        result = {'interrupted': str(error)[:500]}
    finally:
        for _ in range(20):
            kill_tree(os.getpid())
            try:
                while os.waitpid(-1,os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                break
            time.sleep(0.025)
        token_file.unlink(missing_ok=True)
        save(folder/'result',result)


def control(op):
    job = json.load(sys.stdin)
    if op == 'idle':
        return not any(live(json.loads(p.read_text())) for p in ROOT.glob('*/*/state'))
    ticket, run, token = (job[k] for k in ('ticket','run','token'))
    if not all(re.fullmatch('[a-f0-9]{32}', x) for x in (ticket, run)) or not re.fullmatch('[a-f0-9]{64}',token):
        raise ValueError('无效任务')
    scope = ROOT / ticket
    folder = scope / run
    digest = hashlib.sha256(token.encode()).hexdigest()
    with (ROOT/'.registry').open('a') as registry:
        fcntl.flock(registry, fcntl.LOCK_EX)
        if (folder/'state').is_file():
            state = json.loads((folder/'state').read_text())
            if digest != state['grant']:
                raise ValueError('任务凭证无效')
            if (folder/'result').exists() or not live(state):
                if op == 'ack':
                    shutil.rmtree(folder)
                    return {'state':'finished'}
                progress = {k:state[k] for k in ('startedAt','at','step')}
                if op == 'cancel':
                    return {'state':'finished','progress':progress}
                result = json.loads((folder/'result').read_text()) if (folder/'result').exists() else {'interrupted':'工作进程已退出'}
                if result.get('receipt'):
                    # The durable receipt is immutable. Do not hold up another worker's start to read it.
                    fcntl.flock(registry, fcntl.LOCK_UN)
                    result = json.loads((Path('/work/tasks')/ticket/('.receipt-'+run)).read_text())
                return {'state':'finished','result':result,'progress':progress}
            if op == 'cancel':
                (folder/'cancel').touch()
            return {'state':'running','progress':{k:state[k] for k in ('startedAt','at','step')}}
        if op != 'start':
            return {'state':'missing'}
        if any(live(json.loads(p.read_text())) for p in scope.glob('*/state')):
            return {'state':'busy'}
        folder.mkdir(parents=True,exist_ok=True)
        now = int(time.time()*1000)
        with tempfile.TemporaryFile(dir='/work') as inp:
            inp.write(json.dumps(job,ensure_ascii=False).encode())
            inp.seek(0)
            proc = subprocess.Popen([sys.executable,__file__,'work',str(folder)], stdin=inp,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        birth = Path(f'/proc/{proc.pid}/stat').read_text().rsplit(')',1)[1].split()[19]
        state = {'pid':proc.pid,'birth':birth,'grant':digest,'startedAt':now,'at':now,'step':'启动工作区'}
        save(folder/'state',state)
        return {'state':'running','progress':{k:state[k] for k in ('startedAt','at','step')}}


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1]=='work':
        supervise(Path(sys.argv[2]))
    else:
        print(json.dumps(control(sys.argv[1]),ensure_ascii=False))
