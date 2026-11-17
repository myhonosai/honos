import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** This page is now part of Classes > Calendar (2026-11-16); old links and bookmarks land on the matching place there. */
export default function MovedToCalendar(): never { redirect('/staff/schedule'); }
