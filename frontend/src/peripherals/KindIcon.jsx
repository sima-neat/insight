// Device-kind icons for the Peripherals rail. Inline so they inherit
// `currentColor`: the greyed state is a colour change in CSS, not a second file.
const PATHS = {
  camera: (
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="2" />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5z" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  lidar: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <path d="M10 8a5.66 5.66 0 0 1 0 8M13 5a9.9 9.9 0 0 1 0 14M16 2a14.14 14.14 0 0 1 0 20" />
    </>
  ),
  device: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </>
  )
}

export default function KindIcon({ icon }) {
  return (
    <svg
      className="periph-kind-svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[icon] || PATHS.device}
    </svg>
  )
}
