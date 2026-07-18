import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Easy_CLIProxyAPI 渲染异常', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="app-error-boundary">
        <section className="empty-state">
          <strong>页面渲染出现异常</strong>
          <span>{this.state.error.message || '未知错误'}</span>
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
        </section>
      </main>
    );
  }
}
