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

/** Logo mark «Gipfel»: a geometric Matterhorn peak with a lit face, a shadow face and a snow cap, for the brand square. */
export function MatterhornMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M4 26 L16 5 L19.5 11 L17.2 11.8 L21 17 L28 26 Z" fill="currentColor" opacity="0.55" />
      <path d="M4 26 L16 5 L19.5 11 L17.2 11.8 L15.3 15 L13.6 26 Z" fill="currentColor" />
      <path d="M13.3 10 L16 5 L19.5 11 L17.2 11.8 L15.3 10.6 Z" fill="var(--snow, currentColor)" />
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
