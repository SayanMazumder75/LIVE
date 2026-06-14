/**
 * Inline SVG icon set. Heroicons-derived paths (MIT licence) reproduced
 * verbatim so the bundle doesn't pull in an icon library. All icons
 * use `currentColor` so they pick up surrounding `text-…` classes.
 */

const baseProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
  focusable: "false",
};

export function MicIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
      <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
    </svg>
  );
}

export function MicMutedIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path
        fillRule="evenodd"
        d="M3.53 2.47a.75.75 0 0 0-1.06 1.06l3.722 3.722A4.5 4.5 0 0 0 6 9.001v3a4.502 4.502 0 0 0 .638 2.31l1.082-1.082a3 3 0 0 1-.22-1.227V9c0-.4.078-.78.22-1.13l5.39 5.39a3 3 0 0 1-3.59-2.95V9.622L3.53 2.47Z m11.78 11.78A6 6 0 0 1 6 12V9.622L4.94 8.561A7.502 7.502 0 0 0 11.25 16.45V18.75H8.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-3v-2.302c.69-.083 1.354-.276 1.965-.566l-1.405-1.408ZM18 9v3a6 6 0 0 1-.075.949l1.146 1.146A7.5 7.5 0 0 0 19.5 12V9a.75.75 0 0 0-1.5 0Z m-3.751-4.751a3 3 0 0 0-5.998 0v.502l5.998 5.998V4.249Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function SystemAudioIcon({ className = "h-5 w-5", ...rest }) {
  // Speaker / loudspeaker — chosen for its clear "audio output" mental
  // model. Matches the speaker icon Chrome itself uses on tab audio.
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.348 2.595.341 1.24 1.518 1.905 2.66 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
      <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

export function SunIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M12 2.25a.75.75 0 0 1 .75.75v2.25a.75.75 0 0 1-1.5 0V3a.75.75 0 0 1 .75-.75ZM7.5 12a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM18.894 6.166a.75.75 0 0 0-1.06-1.06l-1.591 1.59a.75.75 0 1 0 1.06 1.061l1.591-1.59ZM21.75 12a.75.75 0 0 1-.75.75h-2.25a.75.75 0 0 1 0-1.5H21a.75.75 0 0 1 .75.75ZM17.834 18.894a.75.75 0 0 0 1.06-1.06l-1.59-1.591a.75.75 0 1 0-1.061 1.06l1.59 1.591ZM12 18a.75.75 0 0 1 .75.75V21a.75.75 0 0 1-1.5 0v-2.25A.75.75 0 0 1 12 18ZM7.758 17.303a.75.75 0 0 0-1.061-1.06l-1.591 1.59a.75.75 0 0 0 1.06 1.061l1.591-1.59ZM6 12a.75.75 0 0 1-.75.75H3a.75.75 0 0 1 0-1.5h2.25A.75.75 0 0 1 6 12ZM6.697 7.757a.75.75 0 0 0 1.06-1.06l-1.59-1.591a.75.75 0 0 0-1.061 1.06l1.59 1.591Z" />
    </svg>
  );
}

export function MoonIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M9.528 1.718a.75.75 0 0 1 .162.819A8.97 8.97 0 0 0 9 6a9 9 0 0 0 9 9 8.97 8.97 0 0 0 3.463-.69.75.75 0 0 1 .981.98 10.503 10.503 0 0 1-9.694 6.46c-5.799 0-10.5-4.7-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 0 1 .818.162Z" />
    </svg>
  );
}

export function PlayIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M8 5.14v13.72a.5.5 0 0 0 .77.42l11-6.86a.5.5 0 0 0 0-.84l-11-6.86A.5.5 0 0 0 8 5.14Z" />
    </svg>
  );
}

export function StopIcon({ className = "h-5 w-5", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function ExternalIcon({ className = "h-4 w-4", ...rest }) {
  return (
    <svg {...baseProps} className={className} {...rest}>
      <path d="M14.25 4.5a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V6.31l-6.97 6.97a.75.75 0 0 1-1.06-1.06L17.69 5.25H15a.75.75 0 0 1-.75-.75Z" />
      <path d="M5.25 6.75A1.5 1.5 0 0 0 3.75 8.25v9.5A1.5 1.5 0 0 0 5.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-3.75a.75.75 0 0 0-1.5 0v3.75H5.25v-9.5h3.75a.75.75 0 0 0 0-1.5h-3.75Z" />
    </svg>
  );
}
