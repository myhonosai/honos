import { spawnSync } from 'node:child_process';

const secureCreate = String.raw`
import os
import stat
import sys

directory, filename, expected_dev, expected_ino = sys.argv[1:]
if '/' in filename or filename in ('', '.', '..'):
    raise SystemExit(20)
dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    directory_stat = os.fstat(dir_fd)
    if (not stat.S_ISDIR(directory_stat.st_mode)
            or directory_stat.st_dev != int(expected_dev)
            or directory_stat.st_ino != int(expected_ino)):
        raise SystemExit(21)
    file_fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        file_stat = os.fstat(file_fd)
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.getuid():
            raise SystemExit(22)
        payload = sys.stdin.buffer.read()
        offset = 0
        while offset < len(payload):
            offset += os.write(file_fd, payload[offset:])
        os.fchmod(file_fd, 0o600)
        os.fsync(file_fd)
        final_stat = os.fstat(file_fd)
        if (not stat.S_ISREG(final_stat.st_mode)
                or final_stat.st_uid != os.getuid()
                or stat.S_IMODE(final_stat.st_mode) != 0o600):
            raise SystemExit(23)
    finally:
        os.close(file_fd)
finally:
    os.close(dir_fd)
`;

/**
 * Creates a mode-0600 credential file using openat-style directory-descriptor
 * semantics. The directory's device/inode must match the caller's verified
 * identity before the filename is created or credentials are written.
 */
export function createExclusiveValidationEnv({ directory, filename, directoryStat, content, environment }) {
  if (!directoryStat?.isDirectory?.() || directoryStat.isSymbolicLink?.() || directoryStat.uid !== process.getuid()) {
    throw new Error('Credential-file parent directory is unsafe.');
  }
  const result = spawnSync('python3', ['-c', secureCreate, directory, filename, String(directoryStat.dev), String(directoryStat.ino)], {
    input: content,
    encoding: 'utf8',
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error('Secure private credential-file creation failed.');
  }
}
