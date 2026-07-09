// Purely decorative chicken-art panel for the Login page (login-art.svg,
// supplied for this purpose), anchored toward the bottom-right of whatever
// box this panel is given — the caller controls that box's size/position
// (right side on desktop, below the form on mobile). No background of its
// own so it matches the page (bg-app on the shared container) rather than
// showing as a distinct panel. Entirely aria-hidden: it carries no
// information, so it must never appear to assistive tech or interrupt tab
// order.
export function LoginArtPanel({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`relative overflow-hidden ${className}`}>
      <img
        src="/login-art.svg"
        alt=""
        className="absolute bottom-0 right-0 w-[90%] max-w-sm lg:w-[85%] lg:max-w-none xl:w-[26rem]"
      />
    </div>
  );
}
