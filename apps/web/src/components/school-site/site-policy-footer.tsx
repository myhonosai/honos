import React from 'react';
import styles from './school-site.module.css';

/** A2P step 2: every school site page ends with links to the built-in privacy policy and terms pages. */
export function SitePolicyFooter({ schoolName, base }: { schoolName: string; base: string }) {
  return <footer className={styles.footer}><p>© {schoolName}</p>
    <nav aria-label="Policies" className={styles.footerLinks}><a href={`${base}/privacy`}>Privacy policy</a><a href={`${base}/terms`}>Terms of use</a></nav>
  </footer>;
}
