import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogOut } from 'lucide-react';
import appLogo from '../assets/logo.jpg';
import { useI18n } from '../i18n';
import { isWebUi, useWebAuthStatus, webAuth } from '../services/platform';
import { Dialog } from './Dialog';
import { Notice } from './Notice';
import './WebLoginScreen.css';

function webText(locale: string, key: string): string {
  const zh = locale.startsWith('zh');
  const map: Record<string, [string, string]> = {
    subtitle: ['无头 WebUI 控制台', 'Headless WebUI Console'],
    passwordLabel: ['访问密码', 'Access Password'],
    passwordPlaceholder: ['请输入 WebUI 访问密码', 'Enter WebUI access password'],
    signIn: ['登录', 'Sign In'],
    signingIn: ['正在验证…', 'Signing in…'],
    firstRunHint: [
      '首次启动如未指定密码，系统会在服务端终端日志打印一次随机密码，密码哈希保存在数据目录的 webui.toml 中。',
      'On first run without a configured password, the server prints a one-time random password to stdout and stores its hash in webui.toml.',
    ],
    emptyPassword: ['请输入访问密码', 'Please enter the access password'],
    changePassword: ['修改 WebUI 密码', 'Change WebUI Password'],
    currentPassword: ['当前密码', 'Current Password'],
    newPassword: ['新密码（至少 8 位）', 'New Password (at least 8 characters)'],
    confirmPassword: ['确认新密码', 'Confirm New Password'],
    mismatch: ['两次输入的新密码不一致', 'New passwords do not match'],
    tooShort: ['新密码至少需要 8 个字符', 'New password must be at least 8 characters'],
    updated: ['WebUI 密码已更新', 'WebUI password updated'],
    save: ['保存密码', 'Save Password'],
    saving: ['保存中…', 'Saving…'],
    cancel: ['取消', 'Cancel'],
    logout: ['退出登录', 'Sign Out'],
    showPassword: ['显示密码', 'Show password'],
    hidePassword: ['隐藏密码', 'Hide password'],
  };
  const pair = map[key];
  return pair ? (zh ? pair[0] : pair[1]) : key;
}

export function WebLoginScreen({ version }: { version?: string }) {
  const { locale } = useI18n();
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim()) {
      setError(webText(locale, 'emptyPassword'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await webAuth.login(password);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="web-login-shell">
      <div className="web-login-card" role="main">
        <div className="web-login-header">
          <img className="web-login-logo" src={appLogo} alt="" aria-hidden="true" />
          <div>
            <h1 className="web-login-title">EasyCLIProxyAPI</h1>
            <p className="web-login-subtitle">
              {webText(locale, 'subtitle')}
              {version ? ` · v${version}` : ''}
            </p>
          </div>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <form className="web-login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="web-login-field">
            <span className="web-login-label">{webText(locale, 'passwordLabel')}</span>
            <span className="web-login-input-wrap">
              <input
                type={visible ? 'text' : 'password'}
                className="web-login-input"
                autoComplete="current-password"
                autoFocus
                disabled={submitting}
                placeholder={webText(locale, 'passwordPlaceholder')}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="web-login-toggle-visibility"
                aria-label={webText(locale, visible ? 'hidePassword' : 'showPassword')}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </span>
          </label>

          <button
            type="submit"
            className="primary-button web-login-submit"
            disabled={submitting}
          >
            <Lock size={15} aria-hidden="true" />
            <span>{webText(locale, submitting ? 'signingIn' : 'signIn')}</span>
          </button>
        </form>

        <p className="web-login-hint">{webText(locale, 'firstRunHint')}</p>
      </div>
    </div>
  );
}

export function WebAccountControls() {
  const { locale } = useI18n();
  const auth = useWebAuthStatus();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isWebUi() || !auth.authRequired) {
    return null;
  }

  const closeDialog = () => {
    setPasswordDialogOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setSuccess('');
  };

  const handleSavePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword.length < 8) {
      setError(webText(locale, 'tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(webText(locale, 'mismatch'));
      return;
    }
    setSaving(true);
    try {
      await webAuth.changePassword(currentPassword, newPassword);
      setSuccess(webText(locale, 'updated'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="sidebar-link"
        aria-label={webText(locale, 'changePassword')}
        title={webText(locale, 'changePassword')}
        onClick={() => setPasswordDialogOpen(true)}
      >
        <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{webText(locale, 'changePassword')}</span>
      </button>
      <button
        type="button"
        className="sidebar-link"
        aria-label={webText(locale, 'logout')}
        title={webText(locale, 'logout')}
        onClick={() => void webAuth.logout()}
      >
        <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{webText(locale, 'logout')}</span>
      </button>

      {passwordDialogOpen ? (
        <Dialog
          className="web-password-dialog"
          labelledBy="web-password-dialog-title"
          onClose={closeDialog}
          closeDisabled={saving}
        >
          <h2 id="web-password-dialog-title" className="web-login-title">
            {webText(locale, 'changePassword')}
          </h2>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {success ? <Notice tone="success">{success}</Notice> : null}
          <form className="web-login-form" onSubmit={(e) => void handleSavePassword(e)}>
            <label className="web-login-field">
              <span className="web-login-label">{webText(locale, 'currentPassword')}</span>
              <input
                type="password"
                className="web-login-input"
                autoComplete="current-password"
                disabled={saving}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
            <label className="web-login-field">
              <span className="web-login-label">{webText(locale, 'newPassword')}</span>
              <input
                type="password"
                className="web-login-input"
                autoComplete="new-password"
                disabled={saving}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label className="web-login-field">
              <span className="web-login-label">{webText(locale, 'confirmPassword')}</span>
              <input
                type="password"
                className="web-login-input"
                autoComplete="new-password"
                disabled={saving}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <div className="web-password-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={closeDialog}
              >
                {webText(locale, 'cancel')}
              </button>
              <button type="submit" className="primary-button" disabled={saving}>
                {webText(locale, saving ? 'saving' : 'save')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
