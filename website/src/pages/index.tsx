import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Hero from '@site/src/components/home/Hero';
import Explainer from '@site/src/components/home/Explainer';
import Problem from '@site/src/components/home/Problem';
import Ladder from '@site/src/components/home/Ladder';
import Proof from '@site/src/components/home/Proof';
import Compare from '@site/src/components/home/Compare';
import Quickstart from '@site/src/components/home/Quickstart';
import Redline from '@site/src/components/home/Redline';
import Honest from '@site/src/components/home/Honest';
import {FinalCta} from '@site/src/components/home/Closing';
import YourCost from '@site/src/components/home/YourCost';

export default function Home() {
  return (
    <Layout
      title="Peer-to-peer calls where your servers never carry the media"
      description="Freehop is an open-source peer-to-peer voice, video and data SDK. You run only blind gates for sealed signalling; the media hops between the people in the call.">
      <Head>
        <html className="fh-home" />
      </Head>
      <main>
        <Hero />
        <Explainer />
        <Problem />
        <Ladder />
        <YourCost />
        <Proof />
        <Compare />
        <Quickstart />
        <Redline />
        <Honest />
        <FinalCta />
      </main>
    </Layout>
  );
}
