/*
 * ========================================================================
 * 步骤1：在网页隔离世界运行固定的 DOM 操作
 * ========================================================================
 * 数据源：当前网页 DOM，不读取工作台和系统对象。
 * 操作：1) 快照分配短期元素引用；2) 只允许固定动作，不接收模型 JavaScript。
 */
export const BROWSER_PAGE_SCRIPT = `(input) => {
 const logger = console;
 logger.info("开始处理浏览器元素操作");
 try {
  // 1.1 元素表保存在隔离世界，导航后自然失效。
  if (input.action === "snapshot") {
   const refs = new Map();
   const prefix = Math.random().toString(36).slice(2, 10);
   const elements = [];
   const warnings = [];
   const visit = (root, frame) => {
    for (const element of root.querySelectorAll('*')) {
     if (elements.length >= 250) break;
     const rect = element.getBoundingClientRect();
     if (!rect.width || !rect.height || element.hidden || element.getAttribute('aria-hidden') === 'true') continue;
     if (element.shadowRoot) visit(element.shadowRoot, frame);
     if (element.tagName === 'IFRAME') {
      try { if (element.contentDocument) visit(element.contentDocument, frame + ' / iframe'); else warnings.push('跨域 iframe 需单独打开其地址：' + (element.src || '未知')); } catch { warnings.push('跨域 iframe 需单独打开'); }
     }
     if (!element.matches('a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[contenteditable=true],[role=checkbox],[role=combobox]')) continue;
     const ref = prefix + '-' + (elements.length + 1);
     refs.set(ref, element);
     const label = element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || element.name || '';
     elements.push({ ref, tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || element.type || '', label: String(label).trim().slice(0, 240), value: element.type === 'password' ? '[密码已隐藏]' : String(element.value || '').slice(0, 300), frame, options: element.tagName === 'SELECT' ? Array.from(element.options).slice(0, 50).map(item => ({ value: item.value, label: item.text })) : undefined });
    }
   };
   visit(document, 'main');
   globalThis.harnessBrowserRefs = refs;
   const text = (document.querySelector('main,article,[role=main]') || document.body)?.innerText || '';
   return { title: document.title, url: location.href, text: text.slice(0, 20000), truncated: text.length > 20000 || elements.length >= 250, elements, warnings: [...new Set(warnings)].slice(0, 10) };
  }
  if (input.action === 'scroll') { window.scrollBy(0, input.direction === 'up' ? -input.pixels : input.pixels); return { scrolled: true }; }
  const element = globalThis.harnessBrowserRefs?.get(input.ref);
  if (!element?.isConnected) throw new Error('元素引用已失效，请重新读取页面快照');
  if (!element.getClientRects().length || element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'hidden') throw new Error('元素已隐藏，请重新读取页面快照');
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('元素已禁用');
  // 1.2 填写通过原生 setter 通知框架，不拼接用户文本到脚本。
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (input.action === 'click') { element.click(); return { clicked: true }; }
  if (input.action === 'fill') {
   if (element.readOnly) throw new Error('输入框为只读');
   element.focus();
   const view = element.ownerDocument.defaultView;
   if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    const prototype = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, input.text);
   } else if (element.isContentEditable) element.textContent = input.text;
   else throw new Error('该元素不能填写');
   element.dispatchEvent(new view.Event('input', { bubbles: true }));
   element.dispatchEvent(new view.Event('change', { bubbles: true }));
   return { filled: true };
  }
  if (input.action === 'select') {
   if (element.tagName !== 'SELECT' || !Array.from(element.options).some(item => item.value === input.value)) throw new Error('下拉选项不存在');
   element.value = input.value;
   element.dispatchEvent(new element.ownerDocument.defaultView.Event('change', { bubbles: true }));
   return { selected: true };
  }
  throw new Error('未知网页动作');
 } finally { logger.info("浏览器元素操作结束"); }
}`;
