import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import type {PrismTheme} from 'prism-react-renderer';

// Runs in Node.js at build time. No browser APIs here.

const GITHUB = 'https://github.com/jolynstudios/freehop';

// Code colours from the documentation palette: plum, cobalt, teal and rust on a pale
// lavender surface. Every token colour keeps at least 4.5:1 contrast on the code surface.
const codeTheme: PrismTheme = {
  plain: {color: '#303055', backgroundColor: '#f6f6fb'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#62627a', fontStyle: 'italic'}},
    {types: ['keyword', 'atrule', 'important', 'selector'], style: {color: '#8844ae'}},
    {types: ['string', 'char', 'template-string', 'attr-value', 'regex', 'url'], style: {color: '#3b61b0'}},
    {types: ['function', 'class-name', 'builtin', 'tag'], style: {color: '#096e72'}},
    {types: ['number', 'boolean', 'constant', 'symbol', 'inserted'], style: {color: '#984e4d'}},
    {types: ['property', 'attr-name', 'variable', 'parameter'], style: {color: '#303055'}},
    {types: ['punctuation', 'operator'], style: {color: '#55556b'}},
    {types: ['deleted'], style: {color: '#984e4d', textDecorationLine: 'line-through'}},
  ],
};

const config: Config = {
  title: 'Freehop',
  tagline: 'Add peer-to-peer voice, video and data to your app or game.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://jolynstudios.github.io',
  baseUrl: '/freehop/',
  organizationName: 'jolynstudios',
  projectName: 'freehop',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',

  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  clientModules: ['./src/clientModules/pauseOffscreen.ts'],

  headTags: [
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
    {tagName: 'link', attributes: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous'}},
    {tagName: 'meta', attributes: {name: 'theme-color', content: '#ffe600'}},
  ],
  stylesheets: [
    'https://fonts.googleapis.com/css2?family=Changa+One&family=IBM+Plex+Mono:wght@400;500;600&family=Rubik:wght@400;500;600;700&display=swap',
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: `${GITHUB}/tree/main/website/`,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          lastmod: null,
          changefreq: null,
          priority: null,
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    metadata: [
      {name: 'keywords', content: 'webrtc, peer-to-peer, p2p, voice chat, video chat, nat traversal, turn, stun, upnp, pcp, nat-pmp, sdk, games'},
      {name: 'twitter:card', content: 'summary_large_image'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    docs: {
      sidebar: {
        hideable: false,
        autoCollapseCategories: false,
      },
    },
    tableOfContents: {
      minHeadingLevel: 2,
      maxHeadingLevel: 3,
    },
    navbar: {
      title: 'Freehop',
      logo: {
        alt: 'Freehop logo: a paper plane crossing a blue globe',
        src: 'img/logo.svg',
        width: 32,
        height: 32,
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {to: '/docs/concepts/paths', label: 'How it works', position: 'left'},
        {to: '/demos', label: 'Demos', position: 'left'},
        {to: '/docs/protocol', label: 'Protocol', position: 'left'},
        {to: '/docs/quickstart', label: 'Start building', position: 'right', className: 'navbar-live-call'},
        {href: GITHUB, label: 'GitHub', position: 'right', className: 'navbar-github'},
      ],
    },
    prism: {
      theme: codeTheme,
      additionalLanguages: ['bash', 'json', 'ini', 'diff'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
