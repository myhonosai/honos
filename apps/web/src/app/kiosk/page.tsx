import { KioskScreen } from '../../components/kiosk-screen';
export const dynamic='force-dynamic';
export const metadata={title:'HON | Staff Assistance Kiosk',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default function KioskPage() { return <KioskScreen />; }
