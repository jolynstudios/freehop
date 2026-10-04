import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Hero from '@site/src/components/home/Hero';
import AppShowcase from '@site/src/components/home/AppShowcase';
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
      title="Add voice and video to your app with Freehop"
      description="Freehop is an open-source JavaScript SDK for adding peer-to-peer voice, video and data to browser and desktop apps and games.">
      <Head>
        <html className="fh-home" />
      </Head>
      <main>
        <Hero />
        <AppShowcase />
        <Quickstart />
        <Explainer />
        <Problem />
        <Ladder />
        <YourCost />
        <Proof />
        <Compare />
        <Redline />
        <Honest />
        <FinalCta />
      </main>
    </Layout>
  );
}
