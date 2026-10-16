import { constants, openSync, fstatSync, closeSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { requireOwnerLaunchLocalUrls, refuseOwnerLaunchExternalEnvironment } from './owner-launch-local-guard.mjs';
export function loadOwnerLaunchValidationEnv() {
 refuseOwnerLaunchExternalEnvironment();
 if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Refusing inherited database credentials; use only the generated private fixture descriptor.');
 const file=process.env.HON_OWNER_LAUNCH_ENV_FILE;
 if (!file || resolve(file)!==file || !file.startsWith('/home/ubuntu/jobs/') || realpathSync(dirname(file))!==dirname(file)) throw new Error('Private normalized job-directory descriptor required.');
 const directory=lstatSync(dirname(file));
 if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid!==process.getuid()) throw new Error('Unsafe private fixture directory.');
 const dir=openSync(dirname(file),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let fd;
 try {
  const current=fstatSync(dir);
  if (current.dev!==directory.dev || current.ino!==directory.ino) throw new Error('Fixture directory changed.');
  fd=openSync(`/proc/self/fd/${dir}/${basename(file)}`,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=fstatSync(fd);
  if (!stat.isFile() || stat.uid!==process.getuid() || (stat.mode&0o777)!==0o600 || stat.nlink!==1 || stat.size>2048) throw new Error('Unsafe fixture credential descriptor.');
  const lines=readFileSync(fd,'utf8').trimEnd().split('\n');
  if (lines.length!==2) throw new Error('Unexpected fixture credential contents.');
  for (const [i,key] of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL'].entries()) {
   const match=lines[i].match(new RegExp(`^export ${key}='(postgresql://[^']+)'$`));
   if (!match) throw new Error('Invalid generated fixture credentials.');
   process.env[key]=match[1];
  }
  requireOwnerLaunchLocalUrls();
 } finally { if (fd!==undefined) closeSync(fd); closeSync(dir); }
}
