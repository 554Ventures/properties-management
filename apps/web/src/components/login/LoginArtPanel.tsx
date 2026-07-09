// Purely decorative chicken-art panel for the Login page (login-art.svg,
// supplied for this purpose). Grey overlapping circles sit behind the
// chicken, both anchored toward the bottom-right of whatever box this panel
// is given — the caller controls that box's size/position (40% width on the
// left on desktop, the remaining space below the form on mobile). Entirely
// aria-hidden: it carries no information, so it must never appear to
// assistive tech or interrupt tab order.
export function LoginArtPanel({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`relative overflow-hidden bg-surface-sunken ${className}`}>
      <div className="absolute inset-0">
        <div className="absolute -top-8 right-[-15%] h-[26rem] w-[26rem] rounded-full bg-neutral opacity-[0.16]" />
        <div className="absolute bottom-[18%] -right-10 h-72 w-72 rounded-full bg-neutral opacity-[0.28]" />
        <div className="absolute bottom-4 right-1/4 h-44 w-44 rounded-full bg-neutral opacity-[0.22]" />
      </div>
      <img
        src="/login-art.svg"
        alt=""
        className="absolute bottom-0 right-0 w-[90%] max-w-sm lg:w-[85%] lg:max-w-none xl:w-[26rem]"
      />
    </div>
  );
}
