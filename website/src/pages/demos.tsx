import Layout from '@theme/Layout';
import PageHeader from '@site/src/components/PageHeader';
import AppShowcase from '@site/src/components/home/AppShowcase';
export default function Demos() {
  return (
    <Layout title="Demos" description="Try Freehop in Hopper or inspect a real voice and video call in the live demo.">
      <main>
        <PageHeader eyebrow="Freehop demos" title="See the SDK at work.">
          <p>Try a complete calling app, or look inside a live session. Both use the real Freehop client.</p>
        </PageHeader>
        <AppShowcase compact />
      </main>
    </Layout>
  );
}
