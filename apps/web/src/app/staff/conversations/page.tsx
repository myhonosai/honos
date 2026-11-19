import { redirect } from 'next/navigation';
import { movedQuery, type SearchParams } from '../../../components/texts/moved-query';

/** The SMS inbox moved to Texts > Conversations (docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md); old links land there with their query. */
export default async function ConversationsMoved({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<never> {
  redirect(`/staff/texts${movedQuery(await searchParams)}`);
}
