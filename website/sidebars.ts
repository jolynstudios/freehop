import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    'quickstart',
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: [
        'concepts/gates',
        'concepts/paths',
        'concepts/gateways',
        'concepts/host-nodes',
        'concepts/forwarding',
        'concepts/security',
        'concepts/cost',
      ],
    },
    {
      type: 'category',
      label: 'SDK reference',
      collapsed: false,
      items: ['sdk/authority', 'sdk/client', 'sdk/desktop', 'sdk/host', 'sdk/gate-service'],
    },
    {
      type: 'category',
      label: 'Specification',
      collapsed: false,
      items: ['protocol', 'architecture'],
    },
    {
      type: 'category',
      label: 'Project',
      collapsed: false,
      items: ['results', 'redline-wars', 'limits', 'license'],
    },
  ],
};

export default sidebars;
