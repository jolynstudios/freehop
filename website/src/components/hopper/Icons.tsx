import type {ReactNode, SVGProps} from 'react';

// Hopper's own icon set: 24-unit grid, round strokes, drawn for this demo.
function Icon({children, ...props}: SVGProps<SVGSVGElement> & {children: ReactNode}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}>
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const MicIcon = (p: P) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11.5" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
  </Icon>
);

export const MicOffIcon = (p: P) => (
  <Icon {...p}>
    <path d="M15 10.5V6a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 4.9 2.3M5.5 11.5a6.5 6.5 0 0 0 10.7 5M18.4 13a6.5 6.5 0 0 0 .1-1.5M12 18v3M8.5 21h7M4 4l16 16" />
  </Icon>
);

export const CamIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2.8" y="6.5" width="13" height="11" rx="3" />
    <path d="M15.8 10.4 21 7.6v8.8l-5.2-2.8z" />
  </Icon>
);

export const CamOffIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10.5 6.5h2.3a3 3 0 0 1 3 3v2.2M15.8 15.2v-.1a3 3 0 0 1-3 2.4h-7a3 3 0 0 1-3-3v-5a3 3 0 0 1 2.4-3M15.8 10.4 21 7.6v8.8l-3-1.6M3 3l18 18" />
  </Icon>
);

export const LeaveIcon = (p: P) => (
  <Icon {...p}>
    <path
      d="M2.6 13.2c5.2-4.6 13.6-4.6 18.8 0 .5.4.5 1.1.1 1.6l-1.7 2a1.2 1.2 0 0 1-1.5.3l-2.6-1.3a1.2 1.2 0 0 1-.6-1.1V13a11 11 0 0 0-6.2 0v1.7c0 .5-.2.9-.6 1.1l-2.6 1.3a1.2 1.2 0 0 1-1.5-.3l-1.7-2c-.4-.5-.4-1.2.1-1.6Z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);

export const PeopleIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="9" cy="8.2" r="3.3" />
    <path d="M3 19.5c.5-3.5 2.9-5.5 6-5.5s5.5 2 6 5.5" />
    <circle cx="16.8" cy="9.2" r="2.6" />
    <path d="M16.2 14.2c2.5.2 4.3 1.9 4.8 4.8" />
  </Icon>
);

export const ChatIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.6 3.6V17h-.9A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5Z" />
    <path d="M7.5 9.5h9M7.5 12.8h5.5" />
  </Icon>
);

export const InfoIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.6" />
    <circle cx="12" cy="7.6" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

export const SlidersIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h9M19 7h1M4 17h2M12 17h8" />
    <circle cx="16" cy="7" r="2.6" />
    <circle cx="9" cy="17" r="2.6" />
  </Icon>
);

export const CaretIcon = (p: P) => (
  <Icon {...p}>
    <path d="m7 14.5 5-5 5 5" />
  </Icon>
);

export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.6" />
    <path d="M15.5 8.5V6.6A2.6 2.6 0 0 0 12.9 4H6.6A2.6 2.6 0 0 0 4 6.6v6.3a2.6 2.6 0 0 0 2.6 2.6h1.9" />
  </Icon>
);

export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

/** Send, drawn as Freehop's paper plane. */
export const SendIcon = (p: P) => (
  <Icon {...p}>
    <path d="M21 3 3 10.4l7.2 2.4L12.6 20Z" />
    <path d="M21 3 10.2 12.8" />
  </Icon>
);

export const NewMeetingIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2.8" y="6.5" width="13" height="11" rx="3" />
    <path d="M15.8 10.4 21 7.6v8.8l-5.2-2.8zM9.3 9.2v5.6M6.5 12h5.6" />
  </Icon>
);

export const HashIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 9h14.5M4.5 15H19M10.2 4 8.4 20M15.6 4l-1.8 16" />
  </Icon>
);

export const SpeakerIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 9.3h3.4L12 5.4v13.2l-4.6-3.9H4z" />
    <path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.3 6.6a7.6 7.6 0 0 1 0 10.8" />
  </Icon>
);

export const LockIcon = (p: P) => (
  <Icon {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.6" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);
