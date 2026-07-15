export function ConfigPanelPage() {
  return (
    <section className="page config-page">
      <div className="config-layout">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>基础配置</h2>
              <p>配置文件和工作目录</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              配置文件
              <input placeholder="待接入配置文件" />
            </label>
            <label className="field">
              工作目录
              <input placeholder="待接入工作目录" />
            </label>
          </div>
        </div>

        <div className="panel quiet-panel">
          <div className="panel-heading">
            <div>
              <h2>连接信息</h2>
              <p>当前前端占位状态</p>
            </div>
          </div>

          <dl className="info-list">
            <div>
              <dt>配置源</dt>
              <dd>未接入</dd>
            </div>
            <div>
              <dt>保存状态</dt>
              <dd>待实现</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
