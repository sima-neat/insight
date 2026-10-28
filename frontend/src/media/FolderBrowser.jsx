import { breadcrumbs, listFolder, playableCount, searchFolder, streamableOnly } from './mediaTree.js'

function FolderIcon() {
  return (
    <svg className="folder-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z" />
    </svg>
  )
}

function plural(count, word, pluralForm = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralForm}`
}

// Folder browser over the /api/media-files tree (issue #113). Rendered by the library panel and
// by the assign dialog; it never talks to the server.
//   tree            the media tree
//   folder          current folder path ('' is the media root)
//   onNavigate      (folderPath) => void
//   filter          scoped search text; matches are searched below `folder`
//   onFilterChange  (text) => void
//   selectedPath    library path of the highlighted file, or ''
//   onSelect        (filePath) => void
//   renderFileLead  optional (filePath) => node placed before the file name (the delete checkbox)
//   fileRowClass    optional (filePath) => extra class for the row ('selected' for checked rows)
//   idPrefix        test-id prefix so the two instances can be told apart
//   showUnsupported list files Insight cannot stream, greyed and tagged, so they can still be
//                   previewed or deleted; off by default, because the assign dialog must not
//                   offer them. Without them, a folder with nothing streamable inside is greyed.
export default function FolderBrowser({
  tree, folder, onNavigate, filter, onFilterChange, selectedPath, onSelect,
  renderFileLead, fileRowClass, idPrefix = 'media', showUnsupported = false,
}) {
  const crumbs = breadcrumbs(folder)
  const query = (filter || '').trim()
  const listing = listFolder(tree, folder)
  const folders = listing.folders
  const visibleFiles = showUnsupported ? listing.files : streamableOnly(listing.files)
  const found = query ? searchFolder(tree, folder, query) : []
  const matches = showUnsupported ? found : streamableOnly(found)
  const folderLabel = folder ? folder.split('/').pop() : 'Media Root'
  const countText = query
    ? `${plural(matches.length, 'match', 'matches')} in ${folderLabel}`
    : plural(playableCount(tree, folder), 'video')

  function fileRow(item, label) {
    const unsupported = item.streamable === false
    const className = ['media-row', item.path === selectedPath ? 'active' : '', unsupported ? 'unsupported' : '',
      fileRowClass ? fileRowClass(item.path) : ''].filter(Boolean).join(' ')
    return (
      <div
        key={item.path}
        className={className}
        data-testid={`${idPrefix}-file`}
        data-path={item.path}
        data-streamable={unsupported ? 'false' : 'true'}
      >
        {renderFileLead ? renderFileLead(item.path) : <span className="media-row-lead" aria-hidden="true" />}
        <button type="button" className="media-row-preview" onClick={() => onSelect(item.path)}>
          <span className="media-name">{label}</span>
          {unsupported
            ? <span className="media-ext unsupported-tag" title="Insight cannot stream this file">NOT STREAMABLE</span>
            : <span className="media-ext">{item.path.split('.').pop()?.toUpperCase() || 'FILE'}</span>}
        </button>
      </div>
    )
  }

  return (
    <div className="folder-browser" data-testid={`${idPrefix}-browser`} data-folder={folder}>
      <div className="folder-nav">
        <nav className="breadcrumb" aria-label="Current folder" data-testid={`${idPrefix}-breadcrumb`}>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <span key={crumb.path || 'root'} className="crumb">
                {index > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
                {last
                  ? <span className="crumb-current" aria-current="location">{crumb.name}</span>
                  : <button type="button" className="crumb-link" onClick={() => onNavigate(crumb.path)}>{crumb.name}</button>}
              </span>
            )
          })}
        </nav>
      </div>
      <p className="meta-count" data-testid={`${idPrefix}-count`} title={query ? undefined : `Streamable videos in ${folderLabel} and its subfolders`}>{countText}</p>
      <div className="media-toolbar">
        <input
          className="search-input"
          placeholder={`Filter files in ${folderLabel}...`}
          value={filter || ''}
          onChange={(e) => onFilterChange(e.target.value)}
          aria-label="Filter files in the current folder and its subfolders"
        />
      </div>
      <div className="media-list">
        {query && matches.map((item) => fileRow(item, item.relative))}
        {query && matches.length === 0 && <p className="empty">No files match the filter.</p>}
        {!query && folders.map((item) => (
          <button
            type="button"
            key={item.path}
            className={!showUnsupported && item.count === 0 ? 'media-row folder-row unsupported' : 'media-row folder-row'}
            title={!showUnsupported && item.count === 0 ? 'No video in this folder can be streamed' : undefined}
            onClick={() => onNavigate(item.path)}
            data-testid={`${idPrefix}-folder`}
            data-path={item.path}
            data-streamable={item.count > 0 ? 'true' : 'false'}
            aria-label={`Open folder ${item.name}`}
          >
            <FolderIcon />
            <span className="media-name">{item.name}</span>
            <span className="folder-count" title={`${plural(item.count, 'streamable video')} in ${item.name} and its subfolders`}>{item.count}</span>
          </button>
        ))}
        {!query && visibleFiles.map((item) => fileRow(item, item.name))}
        {!query && folders.length === 0 && visibleFiles.length === 0 && (
          <p className="empty" data-testid={`${idPrefix}-empty`}>This folder is empty.</p>
        )}
        {!query && !showUnsupported && listing.hidden > 0 && (
          <p className="hint hidden-note" data-testid={`${idPrefix}-hidden-note`}>
            {plural(listing.hidden, 'file')} hidden because Insight cannot stream {listing.hidden === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>
    </div>
  )
}
