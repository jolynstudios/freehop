import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import type {PrismTheme} from 'prism-react-renderer';

// Runs in Node.js at build time. No browser APIs here.

const GITHUB = 'https://github.com/jolynstudios/freehop';

// Code colours from the documentation palette: plum, cobalt, teal and rust on a pale
// lavender surface. Every token colour keeps at least 4.5:1 contrast on the code surface.
const codeTheme: PrismTheme = {
  plain: {color: '#f0f0f0', backgroundColor: '#0b0b0c'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#a1a4a5', fontStyle: 'italic'}},
    {types: ['keyword', 'atrule', 'important', 'selector'], style: {color: '#c4bddb'}},
    {types: ['string', 'char', 'template-string', 'attr-value', 'regex', 'url'], style: {color: '#c6c6c6'}},
    {types: ['function', 'class-name', 'builtin', 'tag'], style: {color: '#85d9ca'}},
    {types: ['number', 'boolean', 'constant', 'symbol', 'inserted'], style: {color: '#f398ac'}},
    {types: ['property', 'attr-name', 'variable', 'parameter'], style: {color: '#f0f0f0'}},
    {types: ['punctuation', 'operator'], style: {color: '#c6c6c6'}},
    {types: ['deleted'], style: {color: '#f398ac', textDecorationLine: 'line-through'}},
  ],
};

const config: Config = {
  title: 'freehop',
  tagline: 'Build worlds. Bring people. Open-source voice, video and data for games and platforms.',
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

  headTags: [{tagName: 'meta', attributes: {name: 'theme-color', content: '#000000'}}],
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
      defaultMode: 'dark',
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
      title: 'freehop',
      logo: {
        alt: 'Freehop: two connected paths',
        src: 'img/logo.svg',
        width: 32,
        height: 32,
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},

        {to: '/demos', label: 'Demos', position: 'left'},
        {to: '/docs/sdk/desktop', label: 'Electron', position: 'left'},
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
