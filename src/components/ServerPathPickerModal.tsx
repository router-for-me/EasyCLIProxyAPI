import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, File, Folder, X } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  browseServerPath,
  registerServerPathPicker,
  type ServerPathEntry,
  type ServerPathListing,
  type ServerPathPickerOptions,
} from '../services/platform';
import { Dialog } from './Dialog';
import { Notice } from './Notice';
import './ServerPathPickerModal.css';

type PendingRequest = {
  options: ServerPathPickerOptions;
  resolve: (value: string | null) => void;
};

function pickerText(locale: string, key: string): string {
  const zh = locale.startsWith('zh');
  const map: Record<string, [string, string]> = {
    defaultDirTitle: ['选择服务器目录', 'Select Server Directory'],
    defaultFileTitle: ['选择服务器文件', 'Select Server File'],
    go: ['前往', 'Go'],
    up: ['上级目录', 'Parent Directory'],
    loading: ['正在读取服务器目录…', 'Loading server directory…'],
    empty: ['此目录为空', 'This directory is empty'],
    selectCurrentDir: ['选择当前目录', 'Select Current Directory'],
    selectPath: ['确定选择', 'Select'],
    cancel: ['取消', 'Cancel'],
    pathPlaceholder: ['输入服务器绝对路径，例如 /etc/ssl', 'Enter server path, e.g. /etc/ssl'],
  };
  const pair = map[key];
  return pair ? (zh ? pair[0] : pair[1]) : key;
}

export function ServerPathPickerHost() {
  const { locale } = useI18n();
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [listing, setListing] = useState<ServerPathListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef<PendingRequest | null>(null);

  const directoriesOnly = Boolean(request?.options.directory);
  const extensions = request?.options.filters?.flatMap((filter) => filter.extensions) ?? [];
  const extensionsKey = extensions.join(',');

  const loadDirectory = useCallback(
    async (targetPath: string | null | undefined, dirsOnly: boolean, exts: string[]) => {
      setLoading(true);
      setError('');
      try {
        const result = await browseServerPath({
          path: targetPath || null,
          directoriesOnly: dirsOnly,
          extensions: exts.length > 0 ? exts : undefined,
        });
        setListing(result);
        setPathInput(result.currentPath);
        setSelectedPath(dirsOnly ? result.currentPath : null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    registerServerPathPicker((options) => new Promise<string | null>((resolve) => {
      if (pendingRef.current) {
        pendingRef.current.resolve(null);
      }
      const next: PendingRequest = { options, resolve };
      pendingRef.current = next;
      setRequest(next);
    }));
    return () => {
      registerServerPathPicker(null);
      if (pendingRef.current) {
        pendingRef.current.resolve(null);
        pendingRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const exts = extensionsKey ? extensionsKey.split(',') : [];
    void loadDirectory(request.options.defaultPath, Boolean(request.options.directory), exts);
  }, [request, extensionsKey, loadDirectory]);

  const finish = (value: string | null) => {
    const active = pendingRef.current;
    pendingRef.current = null;
    setRequest(null);
    setListing(null);
    setSelectedPath(null);
    setError('');
    active?.resolve(value);
  };

  if (!request) {
    return null;
  }

  const title = request.options.title
    || pickerText(locale, directoriesOnly ? 'defaultDirTitle' : 'defaultFileTitle');

  const handleGoSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    void loadDirectory(trimmed, directoriesOnly, extensions);
  };

  const handleEntryClick = (entry: ServerPathEntry) => {
    if (entry.isDir) {
      if (directoriesOnly) {
        setSelectedPath(entry.path);
      }
      void loadDirectory(entry.path, directoriesOnly, extensions);
    } else {
      setSelectedPath(entry.path);
    }
  };

  const handleEntryDoubleClick = (entry: ServerPathEntry) => {
    if (entry.isDir) {
      void loadDirectory(entry.path, directoriesOnly, extensions);
    } else {
      finish(entry.path);
    }
  };

  const effectiveSelection = directoriesOnly
    ? (selectedPath || listing?.currentPath || pathInput.trim() || null)
    : (selectedPath || null);

  return (
    <Dialog
      className="server-path-picker-dialog"
      labelledBy="server-path-picker-title"
      onClose={() => finish(null)}
    >
      <div className="server-path-picker-header">
        <h2 id="server-path-picker-title" className="server-path-picker-title">{title}</h2>
        <button
          type="button"
          className="icon-button quiet ghost small-button"
          aria-label={pickerText(locale, 'cancel')}
          onClick={() => finish(null)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <form className="server-path-picker-bar" onSubmit={handleGoSubmit}>
        <button
          type="button"
          className="secondary-button compact-button"
          disabled={loading || !listing?.parentPath}
          title={pickerText(locale, 'up')}
          aria-label={pickerText(locale, 'up')}
          onClick={() => {
            if (listing?.parentPath) {
              void loadDirectory(listing.parentPath, directoriesOnly, extensions);
            }
          }}
        >
          <ArrowUp size={15} aria-hidden="true" />
        </button>
        <input
          type="text"
          className="server-path-picker-input"
          placeholder={pickerText(locale, 'pathPlaceholder')}
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
        />
        <button type="submit" className="secondary-button compact-button" disabled={loading}>
          {pickerText(locale, 'go')}
        </button>
      </form>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="server-path-picker-list" role="listbox" aria-label={title}>
        {loading ? (
          <p className="server-path-picker-empty">{pickerText(locale, 'loading')}</p>
        ) : listing && listing.entries.length > 0 ? (
          listing.entries.map((entry) => {
            const isSelected = selectedPath === entry.path;
            return (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`server-path-picker-item${isSelected ? ' selected' : ''}`}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
              >
                {entry.isDir
                  ? <Folder size={15} aria-hidden="true" />
                  : <File size={15} aria-hidden="true" />}
                <span className="server-path-picker-item-name">{entry.name}</span>
              </button>
            );
          })
        ) : (
          <p className="server-path-picker-empty">{pickerText(locale, 'empty')}</p>
        )}
      </div>

      <div className="server-path-picker-footer">
        <span className="server-path-picker-selected" title={effectiveSelection ?? ''}>
          {effectiveSelection ?? ''}
        </span>
        <div className="server-path-picker-actions">
          <button type="button" className="secondary-button" onClick={() => finish(null)}>
            {pickerText(locale, 'cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!effectiveSelection}
            onClick={() => finish(effectiveSelection)}
          >
            {pickerText(locale, directoriesOnly ? 'selectCurrentDir' : 'selectPath')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
