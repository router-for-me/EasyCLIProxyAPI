import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { AgentsPage } from '../../src/pages/AgentsPage';
import { I18nProvider } from '../../src/i18n';
import '../../src/styles.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale','zh-CN');
localStorage.setItem('cpa-gui.agent-selected-client.v1', params.get('client') || 'codex');
const ids = ['claude-code','claude-desktop','codex','opencode','openclaw','hermes','deepseek-harness','zcode','kimi-code','grok-build','pi'];
let count=0; let currentModel=params.has('fresh')?null:'gpt-one';
const calls:any[]=[];(window as any).fixtureCalls=calls;
mockIPC(async (cmd,args:any) => {
 calls.push({cmd,args});
 if(cmd==='plugin:event|listen') return 1;
 if(cmd==='plugin:event|unlisten'||cmd==='set_app_locale') return null;
 if(cmd==='get_agent_config_statuses'||cmd==='refresh_agent_config_statuses') return ids.map(id=>({id,name:id,supportedPlatform:true,installed:true,pluginInstalled:true,launchTargets:[{id:'cli',label:'CLI',detail:'test'}],version:'1.0',cliVersion:'1.0',appVersion:null,pluginVersion:'1.0',configValid:params.get('state')!=='invalid',connectionState:params.get('state') || (currentModel?'configured':'not-configured'),configured:!!currentModel,configurationSynchronized:!!currentModel,currentModel,oauthConfiguration:false,modificationEnabled:!!currentModel,modificationState:currentModel?'applied':'unconfigured',backupAvailable:false,appliedModel:currentModel,claudeCodeModelMappings:null,claudeDesktopModelMappings:null,warnings:[],error:null}));
 if(cmd==='get_agent_models') return [{name:'gpt-one'},{name:'gpt-two'}];
 if(cmd==='get_deepseek_harness_process_status') return {running:false,pid:null,mode:null};
 if(cmd==='update_agent_config') {count++;currentModel=args.model;return {outcome:count>1?'unchanged':'updated',historyVersion:'2',model:currentModel,enabled:true,changedFiles:[],conflictFiles:[]};}
 if(cmd==='list_agent_config_history') return {versions:[{id:'1',createdAt:'2026-09-09T12:00:00Z',source:'before-update',model:'gpt-two',fileCount:3}],warnings:[]};
 if(cmd==='preview_agent_config_history') return {revision:'rev1',differences:[{file:'C:/test/.codex/config.toml',field:'model',before:'gpt-one',after:'gpt-two'},{file:'C:/test/.codex/auth.json',field:'OPENAI_API_KEY',before:'••••••',after:'••••••'}]};
 if(cmd==='restore_agent_config_history') {currentModel='gpt-two';return {outcome:'updated'};}
 if(cmd==='check_pi_provider_update') return {installedVersion:'1.0',latestVersion:'1.0',updateAvailable:false};
 if(cmd==='get_codex_model_catalog_editor') return {models:[],hiddenModels:[],customizations:{}};
 if(cmd==='check_codex_oauth_login')return null;
 throw new Error('Unhandled fixture command: '+cmd);
});
createRoot(document.getElementById('root')!).render(<I18nProvider><AgentsPage embedded={params.has('embedded')}/></I18nProvider>);
