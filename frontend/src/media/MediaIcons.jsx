export function CameraIcon({ className = 'media-card-icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h11a2 2 0 0 1 2 2v2.5L22 7v10l-5-3.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
    </svg>
  )
}

export function VideoFileIcon({ className = 'media-card-icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path fillRule="evenodd" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v2h2V6H4zm14 0v2h2V6h-2zM4 11v2h2v-2H4zm14 0v2h2v-2h-2zM4 16v2h2v-2H4zm14 0v2h2v-2h-2zM10 8.5v7l6-3.5-6-3.5z" />
    </svg>
  )
}
