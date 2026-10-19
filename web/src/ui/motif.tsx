// Matterhorn motif: a stylized silhouette as seen from Zermatt (summit hook leaning left, Hörnli shoulder on the right).

const MOUNTAIN =
  "M0,110 L0,95 L18,89 L34,91 L50,83 L63,77 L74,67 L83,55 L91,43 L97,32 L101,22 L104,14 L108,9 L114,8 L118,12 L121,20 L126,29 L133,37 L140,43 L145,47 L152,55 L162,63 L174,71 L187,77 L200,81 L200,110 Z";
const BACK_RANGE = "M0,110 L0,86 L22,74 L38,80 L56,66 L70,72 L84,62 L96,70 L150,60 L168,50 L184,58 L200,52 L200,110 Z";
const SNOW = [
  "M108,9 L106,22 L102,34 L98,44",
  "M114,8 L116,21 L120,33 L126,45",
  "M140,43 L139,53 L143,60",
  "M63,77 L75,75 L86,71",
];

/** Wide silhouette with snow lines; color via `currentColor`, snow in `snow`. */
export function MatterhornRidge({ snow = "var(--surface)", back = true, className }: { snow?: string; back?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 110" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      {back && <path d={BACK_RANGE} fill="currentColor" opacity="0.45" />}
      <path d={MOUNTAIN} fill="currentColor" />
      <g fill="none" stroke={snow} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.45">
        {SNOW.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Compact peak for the logo square: Matterhorn silhouette with a snow cap and the Hörnli shoulder. */
export function MatterhornMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M17,27 L22.5,15.5 L26,20 L31,27 Z" fill="currentColor" opacity="0.4" />
      <path d="M1,27 L9.5,17 L13,11 L15.6,4.6 L17,3.5 L18.6,6.8 L21.2,12.5 L24.5,18 L30,27 Z" fill="currentColor" />
      <path d="M13.6,9.8 L15.6,4.6 L17,3.5 L18.6,6.8 L19.9,9.6 C18.9,9.1 18.3,10.2 17.3,9.6 C16.4,9 15.7,10 14.9,9.5 C14.5,9.3 14.1,9.5 13.6,9.8 Z" fill="var(--snow, #ffffff)" opacity="0.95" />
      <path d="M1,27 L31,27" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

/** The logo as shown in the navigation and on the login page: an uploaded image, or the Matterhorn mark in a square. */
export function BrandMark({ logo, size = 30, inverse = false }: { logo?: string; size?: number; inverse?: boolean }) {
  if (logo) return <img className="brand-logo" src={logo} alt="" style={{ height: size, maxWidth: size * 4 }} />;
  return (
    <span className={`brand-mark ${inverse ? "brand-mark-inverse" : ""}`} style={{ width: size, height: size }}>
      <MatterhornMark />
    </span>
  );
}
