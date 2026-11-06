/** The school entry page is itself the school chooser; it renders without the shell and without the shell's reads. */
export const SCHOOL_SHELL_BARE_ROUTES: readonly string[] = ['/staff/entry'];

/** Every /staff page except the bare ones is wrapped by the school app shell (see app/staff/layout.tsx). */
export function isSchoolShellPath(path: string): boolean {
  return (path === '/staff' || path.startsWith('/staff/')) && !SCHOOL_SHELL_BARE_ROUTES.includes(path);
}
