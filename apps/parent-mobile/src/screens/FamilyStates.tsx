import React from 'react';
import { Loading, StateMessage } from '../ui/parts';
import { useFamily, type FamilyState } from '../family/family-data';

/** Renders every non-ready family state. Returns null only when verified data is ready. */
export function FamilyGate({ state }: { state: FamilyState }) {
  const { refresh } = useFamily();
  switch (state.status) {
    case 'ready': return null;
    case 'loading': return <Loading label="Loading your family" />;
    case 'access-denied': return <StateMessage title="Access has changed" body="This account no longer has access to this family at the school. Nothing from the family is shown. If you think this is a mistake, please contact the school." action={{ label: 'Try again', onPress: refresh }} />;
    case 'choose-family': return <StateMessage title="Choose your school" body="Your account is linked to more than one school or family. Choosing one in the app is coming in the next update; for now, no family is picked for you automatically." action={{ label: 'Try again', onPress: refresh }} />;
    case 'offline': return <StateMessage title="You're offline" body="The app can't reach HON right now. Check your connection and try again. Nothing is shown until it's current." action={{ label: 'Try again', onPress: refresh }} />;
    case 'signed-out': return <Loading label="Signing out" />;
    default: return <StateMessage title="Not available right now" body="HON couldn't load your family's information. Please try again in a moment." action={{ label: 'Try again', onPress: refresh }} />;
  }
}
