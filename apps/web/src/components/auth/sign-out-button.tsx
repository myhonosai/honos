import React from 'react';

/** Plain HTML form: works without client JavaScript and always performs a full navigation. */
export function SignOutButton({ label, className }: { label: string; className?: string | undefined }): React.ReactElement {
  return <form method="post" action="/auth/logout" className={className} data-hon-sign-out>
    <button type="submit">{label}</button>
  </form>;
}
