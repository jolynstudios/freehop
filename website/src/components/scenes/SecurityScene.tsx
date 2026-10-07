import NetworkDiagram from './NetworkDiagram';
export default function SecurityScene({caption}: {caption?: string}) {
  return (
    <NetworkDiagram
      title="Sealed by the client"
      route="HKDF + AES-256-GCM protect signalling envelopes from the gate."
      labels={['Seal', 'Pass ciphertext', 'Open']}
      caption={caption}
    />
  );
}
