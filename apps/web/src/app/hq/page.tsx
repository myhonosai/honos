import { HqControlPlane } from '../../components/hq-control-plane';
import '../hq.css';

export const metadata = {
  title: 'HON HQ | Growth & Operations',
  description: 'The privileged HON Growth & Operations control plane.',
};

export default function HqPage(): React.ReactElement {
  return <HqControlPlane />;
}
