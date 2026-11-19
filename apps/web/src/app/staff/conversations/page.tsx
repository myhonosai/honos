import { redirect } from 'next/navigation';

/** The SMS inbox moved to Texts > Conversations (docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md); old links land there. */
export default function ConversationsMoved(): never { redirect('/staff/texts'); }
