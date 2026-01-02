import * as vscode from 'vscode';
const Twig = require('twig');
const fs = require('fs');
const path = require('path');

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('twigPreview.openPreview', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Ouvrez un fichier .twig pour prévisualiser.');
      return;
    }
    const doc = editor.document;
    if (!doc.fileName.endsWith('.twig') && doc.languageId !== 'twig') {
      vscode.window.showInformationMessage('Ce fichier ne semble pas être un fichier Twig.');
      return;
    }

    const panel = vscode.window.createWebviewPanel('twigPreview', 'Twig Preview', vscode.ViewColumn.Beside, {
      enableScripts: true
    });

    const detectVariables = (tpl: string, baseDir: string | null = null, visited = new Set<string>()) => {
      const result: any = {};

      const assign = (obj: any, pathArr: string[], value: any) => {
        let cur = obj;
        for (let i = 0; i < pathArr.length; i++) {
          const p = pathArr[i];
          if (i === pathArr.length - 1) {
            if (cur[p] === undefined) cur[p] = value;
          } else {
            if (cur[p] === undefined || typeof cur[p] !== 'object') cur[p] = {};
            cur = cur[p];
          }
        }
      };

      const tryLoadInclude = (incPath: string) => {
        if (!baseDir) return null;
        const resolved = path.resolve(baseDir, incPath);
        if (visited.has(resolved)) return null;
        if (fs.existsSync(resolved)) {
          try {
            visited.add(resolved);
            return fs.readFileSync(resolved, 'utf8');
          } catch (e) {
            return null;
          }
        }
        return null;
      };

      // detect for-loops first: map loopVar -> arrayName
      const loopMap: Record<string, string> = {};
      const forRegex = /{%\s*for\s+(\w+)\s+in\s+([\w\.]+)\s*%}/g;
      let m;
      while ((m = forRegex.exec(tpl)) !== null) {
        const loopVar = m[1].trim();
        const arrName = m[2].trim();
        loopMap[loopVar] = arrName;
      }

      // handle includes
      // include with optional `with { ... }`
      const includeRegex = /{%\s*include\s+['\"]([^'\"]+)['\"](?:\s+with\s+(\{[^}]*\}))?\s*%}/g;
      while ((m = includeRegex.exec(tpl)) !== null) {
        const inc = m[1].trim();
        const withPart = m[2];
        // parse with-part into an object and merge into result
        if (withPart) {
          try {
            // try to coerce into JSON: turn single quotes to double quotes for keys/strings
            let s = withPart.trim();
            s = s.replace(/(['"])\s*([a-zA-Z0-9_]+)\s*\1\s*:/g, '"$2":');
            s = s.replace(/'([^']*)'/g, '"$1"');
            const parsed = JSON.parse(s);
            Object.assign(result, parsed);
          } catch (e) {
            // best-effort: ignore parse errors
          }
        }

        const loaded = tryLoadInclude(inc);
        if (loaded) {
          const sub = detectVariables(loaded, baseDir, visited);
          Object.assign(result, sub);
        }
      }

      // collect properties referenced on loop variables: arrName -> set of prop paths
      const arrayProps: Record<string, Set<string>> = {};

      // {{ var }} and {{ var.foo }} etc.
      const varRegex = /{{\s*([^}\s|]+)[^}]*}}/g;
      while ((m = varRegex.exec(tpl)) !== null) {
        const raw = m[1].trim();
        if (!raw) continue;
        if (/^(?:true|false|null|\d+|'.*'|\".*\")$/.test(raw)) continue;
        if (raw.includes('(')) continue;
        const cleaned = raw.replace(/\[.*\]/g, '');
        const parts = cleaned.split('.').map(p => p.trim()).filter(Boolean);
        if (!parts.length) continue;

        // if first part is a loop variable, record property for the array instead of creating the loop var
        if (loopMap[parts[0]]) {
          const arrName = loopMap[parts[0]];
          if (!arrayProps[arrName]) arrayProps[arrName] = new Set<string>();
          if (parts.length === 1) {
            continue;
          } else {
            arrayProps[arrName].add(parts.slice(1).join('.'));
          }
          continue;
        }

        // otherwise it's a top-level var
        assign(result, parts, parts.length === 1 ? parts[0] : {});
      }

      // detect simple if conditions like {% if displayList %}
      const ifRegex = /{%\s*if\s+([^\s%]+)\s*%}/g;
      while ((m = ifRegex.exec(tpl)) !== null) {
        const name = m[1].trim();
        if (name === 'not' || name === 'empty' || name.includes(' ')) continue;
        if (result[name] === undefined) {
          result[name] = true;
        }
      }

      // build arrays from collected props
      for (const arrName in arrayProps) {
        const props = Array.from(arrayProps[arrName]);
        const itemObj: any = {};
        for (const p of props) {
          const parts = p.split('.');
          if (parts.length === 1) {
            const key = parts[0];
            if (key.toLowerCase() === 'value') itemObj[key] = 'valeur 1';
            else itemObj[key] = key + ' 1';
          } else {
            assign(itemObj, parts, parts[parts.length - 1] + ' 1');
          }
        }
        const pathParts = arrName.split('.');
        let cur = result;
        for (let i = 0; i < pathParts.length; i++) {
          const p = pathParts[i];
          if (i === pathParts.length - 1) {
            if (cur[p] === undefined) cur[p] = [itemObj];
            else if (Array.isArray(cur[p]) && cur[p].length === 0) cur[p].push(itemObj);
          } else {
            if (cur[p] === undefined || typeof cur[p] !== 'object') cur[p] = {};
            cur = cur[p];
          }
        }
      }

      return result;
    };

    const detected = detectVariables(doc.getText(), path.dirname(doc.fileName));

    const inlineIncludes = (template: string, baseDir: string | null, visited = new Set<string>()): { content: string, vars: any } => {
      const collected: any = {};
      if (!baseDir) return { content: template, vars: {} };
      const includeRegex = /{%\s*include\s+['\"]([^'\"]+)['\"](?:\s+with\s+(\{[^}]*\}))?\s*%}/g;
      const out = template.replace(includeRegex, (match: string, incPath: string, withPart: string) => {
        try {
          // parse withPart
          if (withPart) {
            try {
              let s = withPart.trim();
              s = s.replace(/(['\"])\s*([a-zA-Z0-9_]+)\s*\1\s*:/g, '"$2":');
              s = s.replace(/'([^']*)'/g, '"$1"');
              const parsed = JSON.parse(s);
              Object.assign(collected, parsed);
            } catch (e) {
              // ignore
            }
          }
          const resolved = path.resolve(baseDir, incPath);
          if (visited.has(resolved)) return '';
          if (fs.existsSync(resolved)) {
            visited.add(resolved);
            const content = fs.readFileSync(resolved, 'utf8');
            const sub = inlineIncludes(content, path.dirname(resolved), visited);
            Object.assign(collected, sub.vars || {});
            return sub.content;
          }
        } catch (e) {
          return '';
        }
        return '';
      });
      return { content: out, vars: collected };
    };

    const renderTemplate = (vars: any = {}) => {
      const original = doc.getText();
      // register noop functions to avoid errors from Symfony/Twig helpers
      try {
        const safeFns = ['path','asset','url','form_widget','form_row','csrf_token','dump','render','form_start','form_end','include'];
        safeFns.forEach((fn: string) => {
          try { Twig.extendFunction(fn, function() { return ''; }); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      const baseDir = path.dirname(doc.fileName);
      const inlined = inlineIncludes(original, baseDir);
      const templ = typeof inlined === 'string' ? inlined : inlined.content;
      const includeVars = (typeof inlined === 'object' && inlined.vars) ? inlined.vars : {};

      // helper: register noop functions for any function-like calls found in template
      const registerNoopForFunctions = (template: string) => {
        try {
          const fnRe = /([a-zA-Z_][\w:]*)\s*\(/g;
          const reserved = new Set(['if','for','set','block','extends','include','in','is','not','filter']);
          const found = new Set<string>();
          let mm;
          while ((mm = fnRe.exec(template)) !== null) {
            const name = mm[1];
            if (!name) continue;
            if (reserved.has(name)) continue;
            // skip numbers
            if (/^\d+$/.test(name)) continue;
            found.add(name);
          }
          found.forEach((fn: string) => {
            try { Twig.extendFunction(fn, function() { return ''; }); } catch (e) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
      };

      // helper: register templates in Twig filesystem for extends/includes
      const registerTemplates = (template: string, baseDir: string | null, visited = new Set<string>()): string => {
        if (!baseDir) return template;
        const extRe = /{%\s*extends\s+['\"]([^'\"]+)['\"]\s*%}/;
        const incRe = /{%\s*include\s+['\"]([^'\"]+)['\"][^%]*%}/g;
        let processed = template;

        // register extends template
        const mExt = extRe.exec(template);
        if (mExt) {
          const parentPath = mExt[1];
          try {
            const resolved = path.resolve(baseDir, parentPath);
            if (!visited.has(resolved) && fs.existsSync(resolved)) {
              visited.add(resolved);
              const parentContent = fs.readFileSync(resolved, 'utf8');
              Twig.twig({ id: parentPath, data: parentContent });
              // recursively register includes in parent
              registerTemplates(parentContent, path.dirname(resolved), visited);
            }
          } catch (e) { /* ignore */ }
        }

        // register include templates
        let mInc;
        while ((mInc = incRe.exec(template)) !== null) {
          const incPath = mInc[1];
          try {
            const resolved = path.resolve(baseDir, incPath);
            if (!visited.has(resolved) && fs.existsSync(resolved)) {
              visited.add(resolved);
              const incContent = fs.readFileSync(resolved, 'utf8');
              Twig.twig({ id: incPath, data: incContent });
              // recursively register includes in included
              registerTemplates(incContent, path.dirname(resolved), visited);
            }
          } catch (e) { /* ignore */ }
        }

        return processed;
      };

      // remove parent() calls explicitly
      let processed = templ.replace(/parent\s*\(\s*\)/g, '');
      // register templates for extends/includes
      registerTemplates(processed, baseDir);
      // register noop for any functions detected
      registerNoopForFunctions(processed);
      // handle extends
      const extMatch = processed.match(/{%\s*extends\s+['\"]([^'\"]+)['\"]\s*%}/);
      let tpl;
      if (extMatch) {
        const parentPath = extMatch[1];
        const parentContent = fs.readFileSync(path.resolve(baseDir, parentPath), 'utf8');
        // remove the extends line from processed
        processed = processed.replace(extMatch[0], '');
        // find blocks in processed (child)
        const blockRegex = /{%\s*block\s+([\w_]+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g;
        let modifiedParent = parentContent;
        let match;
        while ((match = blockRegex.exec(processed)) !== null) {
          const blockName = match[1];
          const blockContent = match[2];
          // replace in parent
          const parentBlockRegex = new RegExp(`{%\\s*block\\s+${blockName}\\s*%}([\\s\\S]*?){%\\s*endblock\\s*%}`, 'g');
          modifiedParent = modifiedParent.replace(parentBlockRegex, blockContent);
        }
        processed = modifiedParent;
        tpl = Twig.twig({ data: processed });
      } else {
        // unwrap blocks for templates without extends
        processed = processed.replace(/{%\s*block\s+([\w_]+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g, (_match, _name, inner) => inner);
        tpl = Twig.twig({ data: processed });
      }
      try {
        const mergedVars = Object.assign({}, includeVars, vars);
        const html = tpl.render(mergedVars);
        panel.webview.postMessage({ type: 'rendered', html });
        return;
      } catch (e) {
        // try to sanitize problematic function calls (Symfony/Twig helpers) and retry
        const funcs = ['path','asset','url','form_widget','form_row','csrf_token','dump','render'];
        const re = new RegExp('\\\b(' + funcs.join('|') + ')\\s*\\([^)]*\\)', 'g');
        const sanitized = templ.replace(re, '');
        const processed2 = sanitized.replace(/{%\s*block\s+([\w_]+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g, (_match, _name, inner) => inner);
        try {
          const tpl2 = Twig.twig({ data: processed2 });
          const mergedVars2 = Object.assign({}, includeVars, vars);
          const html2 = tpl2.render(mergedVars2);
          panel.webview.postMessage({ type: 'rendered', html: html2 });
          return;
        } catch (e2) {
          // as a last resort try removing any function-like calls
          const reAll = /\\b\w+\\s*\([^)]*\)/g;
          const sanitized2 = templ.replace(reAll, '');
          const processed3 = sanitized2.replace(/{%\s*block\s+([\w_]+)\s*%}([\s\S]*?){%\s*endblock\s*%}/g, (_match, _name, inner) => inner);
          try {
            const tpl3 = Twig.twig({ data: processed3 });
            const mergedVars3 = Object.assign({}, includeVars, vars);
            const html3 = tpl3.render(mergedVars3);
            panel.webview.postMessage({ type: 'rendered', html: html3 });
            return;
          } catch (finalErr) {
            panel.webview.postMessage({ type: 'error', message: String(finalErr) });
            return;
          }
        }
      }
    };

    panel.webview.html = getWebviewContent(JSON.stringify(detected, null, 2));

    const msgSub = panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'render') {
        const vars = message.vars || {};
        renderTemplate(vars);
      }
      if (message.type === 'openInBrowser') {
        const html = message.html;
        const projectDir = path.dirname(doc.fileName);
        const previewFile = path.join(projectDir, 'twig-preview-output.html');
        fs.writeFileSync(previewFile, html);
        const uri = vscode.Uri.file(previewFile);
        vscode.env.openExternal(uri);
      }
    }, undefined, context.subscriptions);

    const docChangeSub = vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.document.uri.toString() === doc.uri.toString()) {
        renderTemplate({});
      }
    });

    panel.onDidDispose(() => {
      docChangeSub.dispose();
      msgSub.dispose();
    });

    // initial render
    renderTemplate(detected);
  });

  context.subscriptions.push(cmd);
}

export function deactivate() {}

function getWebviewContent(initialVars: string = '{}'): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' 'unsafe-eval' https:; img-src data: https:;">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.12/codemirror.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.12/theme/material.min.css">
  <style>
    body{font-family: Arial, Helvetica, sans-serif;margin:0;padding:0;color:#ddd;background:#1e1e1e}
    #tabs{display:flex}
    #tabs button{flex:1;padding:8px;border:none;background:#2a2a2a;color:#ddd;cursor:pointer}
    #tabs button.active{background:#444;border-bottom:3px solid #0af}
    #panelVars, #panelPreview{padding:8px}
    .CodeMirror{height:300px;border:1px solid #333}
    .cm-ws:before{content:'·';color:rgba(255,255,255,0.25);position:relative;left:-0.25em}
  </style>
</head>
<body>
  <div id="tabs">
    <button id="bPreview" class="active">Preview</button>
    <button id="bVars">Variables</button>
    <button id="bBrowser">Ouvrir dans le navigateur</button>
  </div>
  <div id="panelPreview" style="position:relative;">
    <div id="preview">Chargement...</div>
  </div>
  <div id="panelVars" style="display:none">
    <textarea id="vars">${initialVars}</textarea>
    <div style="margin-top:8px"><button id="apply">Appliquer</button></div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.12/codemirror.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.12/mode/javascript/javascript.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    let currentHtml = '';
    const tabPreview = document.getElementById('bPreview');
    const tabVars = document.getElementById('bVars');
    const tabBrowser = document.getElementById('bBrowser');
    const panelPreview = document.getElementById('panelPreview');
    const panelVars = document.getElementById('panelVars');
    function setActive(tab){
      ['bPreview','bVars','bBrowser'].forEach(id => document.getElementById(id).classList.remove('active'));
      ['panelPreview','panelVars'].forEach(id => document.getElementById(id).style.display='none');
      if(tab === 'preview'){ tabPreview.classList.add('active'); panelPreview.style.display='block'; }
      else if(tab === 'vars'){ tabVars.classList.add('active'); panelVars.style.display='block'; }
      else if(tab === 'browser'){ 
        const html = currentHtml;
        vscode.postMessage({ type: 'openInBrowser', html });
        setActive('preview');
      }
    }
    tabPreview.addEventListener('click',()=>setActive('preview'));
    tabVars.addEventListener('click',()=>setActive('vars'));
    tabBrowser.addEventListener('click',()=>setActive('browser'));

    const textarea = document.getElementById('vars');
    const editor = CodeMirror.fromTextArea(textarea, {
      mode: {name: 'javascript', json: true},
      lineNumbers: true,
      theme: 'material',
      indentUnit: 2,
      tabSize: 2,
      extraKeys: {
        Tab: function(cm){
          if(cm.somethingSelected()) cm.indentSelection('add');
          else cm.replaceSelection(Array(cm.getOption('indentUnit')+1).join(' '), 'end');
        }
      }
    });

    // overlay to visually mark spaces
    editor.addOverlay({
      token: function(stream){
        if(stream.peek() === ' '){ stream.next(); return 'ws'; }
        while(!stream.eol() && stream.peek() !== ' ') stream.next();
        return null;
      }
    });

    document.getElementById('apply').addEventListener('click',()=>{
      const txt = editor.getValue();
      try{
        const parsed = JSON.parse(txt);
        vscode.postMessage({type:'render', vars: parsed});
        setActive('preview');
      } catch(e) {
        document.getElementById('preview').innerText = 'JSON invalide: ' + e;
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'rendered') {
        currentHtml = msg.html;
        const previewDiv = document.getElementById('preview');
        previewDiv.innerHTML = msg.html;
        // Execute scripts by appending them to the document
        const scripts = previewDiv.querySelectorAll('script');
        scripts.forEach(script => {
          const newScript = document.createElement('script');
          if (script.src) {
            newScript.src = script.src;
          } else {
            newScript.textContent = script.textContent;
          }
          document.body.appendChild(newScript);
        });
      }
      if (msg.type === 'error') {
        document.getElementById('preview').innerText = msg.message;
      }
    });
  </script>
</body>
</html>`;
}
