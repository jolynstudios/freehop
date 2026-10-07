import {Redirect} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

export default function PreviousUseCase() {
  return <Redirect to={useBaseUrl('/docs/use-cases#community-rooms')} />;
}
