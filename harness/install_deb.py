"""Download Debian packages with APT's signed indexes into the unprivileged group prefix."""
import subprocess
import sys
from pathlib import Path

prefix = Path('/work/tools/deb')
cache = Path('/work/tools/apt')
for directory in [prefix, cache/'lists/partial', cache/'archives/partial']:
    directory.mkdir(parents=True, exist_ok=True)
source = cache/'sources.list'
source.write_text('deb https://deb.debian.org/debian trixie main\n')
opts = ['-o', 'Dir::Etc::sourcelist='+str(source), '-o', 'Dir::Etc::sourceparts=-',
        '-o', 'Dir::State::lists='+str(cache/'lists'), '-o', 'Dir::Cache::archives='+str(cache/'archives'),
        '-o','Dir::Cache::pkgcache=','-o','Dir::Cache::srcpkgcache=','-o','Debug::NoLocking=1']
subprocess.run(['apt-get', *opts, 'update'],check=True)
subprocess.run(['apt-get', *opts, '--download-only','--no-install-recommends','-y','install','--',*sys.argv[1:]],check=True)
for package in sorted((cache/'archives').glob('*.deb')):
    subprocess.run(['dpkg-deb','-x',str(package),str(prefix)],check=True)
print('Installed into', prefix)
