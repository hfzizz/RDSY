import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { Sidecar, Bookmark } from '../types'

interface BookmarksPanelProps {
  isOpen: boolean
  sidecar: Sidecar
  currentPage: number
  onClose: () => void
  onNavigate: (page: number) => void
  onSidecarChange: (updated: Sidecar) => void
}

export function BookmarksPanel({
  isOpen,
  sidecar,
  currentPage,
  onClose,
  onNavigate,
  onSidecarChange,
}: BookmarksPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const activeBookmarks = sidecar.bookmarks
    .filter((b) => b.deleted !== true)
    .sort((a, b) => a.page - b.page)

  function handleAddBookmark() {
    const label = window.prompt('Bookmark label:', `Page ${currentPage}`)
    if (label === null) return // user cancelled

    const newBookmark: Bookmark = {
      id: uuidv4(),
      page: currentPage,
      label: label.trim() || `Page ${currentPage}`,
      createdAt: new Date().toISOString(),
    }

    const updated: Sidecar = {
      ...sidecar,
      bookmarks: [...sidecar.bookmarks, newBookmark],
    }
    onSidecarChange(updated)
  }

  function handleDeleteBookmark(id: string) {
    const updated: Sidecar = {
      ...sidecar,
      bookmarks: sidecar.bookmarks.map((b) =>
        b.id === id ? { ...b, deleted: true } : b
      ),
    }
    onSidecarChange(updated)
  }

  return (
    <>
      {/* Backdrop overlay */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 99,
            transition: 'opacity 0.2s',
          }}
        />
      )}

      {/* Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100%',
          width: '280px',
          background: '#16213e',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.5)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            height: '52px',
            borderBottom: '1px solid #2a2a4e',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontWeight: '600',
              fontSize: '15px',
              color: '#e0e0e0',
              letterSpacing: '0.2px',
            }}
          >
            Bookmarks
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '8px',
              minWidth: '44px',
              minHeight: '44px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#e0e0e0'
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#9ca3af'
              e.currentTarget.style.background = 'none'
            }}
            aria-label="Close bookmarks"
          >
            ×
          </button>
        </div>

        {/* Add bookmark button */}
        <div style={{ padding: '12px 16px', flexShrink: 0 }}>
          <button
            onClick={handleAddBookmark}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: '#e94560',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '14px',
              fontWeight: '600',
              cursor: 'pointer',
              minHeight: '44px',
              transition: 'background 0.15s, transform 0.1s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#d63652'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#e94560'
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.98)'
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'scale(1)'
            }}
          >
            + Bookmark this page
          </button>
        </div>

        {/* Bookmark list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 16px 16px',
          }}
        >
          {activeBookmarks.length === 0 ? (
            <div
              style={{
                color: '#6b7280',
                fontSize: '14px',
                textAlign: 'center',
                marginTop: '32px',
                lineHeight: '1.5',
              }}
            >
              No bookmarks yet.
              <br />
              Tap the button above to add one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activeBookmarks.map((bookmark) => (
                <div
                  key={bookmark.id}
                  onClick={() => onNavigate(bookmark.page)}
                  onMouseEnter={() => setHoveredId(bookmark.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 12px',
                    background: hoveredId === bookmark.id ? '#1e2d52' : '#1a1a2e',
                    border: '1px solid #2a2a4e',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                    minHeight: '44px',
                  }}
                >
                  {/* Page chip */}
                  <span
                    style={{
                      background: '#0f3460',
                      color: '#e94560',
                      fontSize: '11px',
                      fontWeight: '700',
                      padding: '3px 7px',
                      borderRadius: '4px',
                      flexShrink: 0,
                      letterSpacing: '0.3px',
                    }}
                  >
                    {bookmark.page}
                  </span>

                  {/* Label */}
                  <span
                    style={{
                      flex: 1,
                      color: '#e0e0e0',
                      fontSize: '13px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {bookmark.label}
                  </span>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteBookmark(bookmark.id)
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#6b7280',
                      fontSize: '16px',
                      cursor: 'pointer',
                      padding: '4px 6px',
                      minWidth: '28px',
                      minHeight: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '4px',
                      flexShrink: 0,
                      transition: 'color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = '#e94560'
                      e.currentTarget.style.background = 'rgba(233,69,96,0.12)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = '#6b7280'
                      e.currentTarget.style.background = 'none'
                    }}
                    aria-label={`Delete bookmark: ${bookmark.label}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default BookmarksPanel
