// Copyright (c) 2015 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
/**
 * @unrestricted
 */
Elements.ClassesPaneWidget = class extends UI.Widget {
  constructor() {
    super(true);
    this.registerRequiredCSS('elements/classesPaneWidget.css');
    this.contentElement.className = 'styles-element-classes-pane';
    var container = this.contentElement.createChild('div', 'title-container');
    this._input = container.createChild('div', 'new-class-input monospace');
    this.setDefaultFocusedElement(this._input);
    this._classesContainer = this.contentElement.createChild('div', 'source-code');
    this._classesContainer.classList.add('styles-element-classes-container');
    this._prompt = new Elements.ClassesPaneWidget.ClassNamePrompt();
    this._prompt.setAutocompletionTimeout(0);
    this._prompt.renderAsBlock();

    var proxyElement = this._prompt.attach(this._input);
    this._prompt.setPlaceholder(Common.UIString('Add new class'));
    this._prompt.addEventListener(UI.TextPrompt.Events.TextChanged, this._onTextChanged, this);
    proxyElement.addEventListener('keydown', this._onKeyDown.bind(this), false);

    SDK.targetManager.addModelListener(SDK.DOMModel, SDK.DOMModel.Events.DOMMutated, this._onDOMMutated, this);
    /** @type {!Set<!SDK.DOMNode>} */
    this._mutatingNodes = new Set();
    /** @type {!Map<!SDK.DOMNode, string>} */
    this._pendingNodeClasses = new Map();
    this._updateNodeThrottler = new Common.Throttler(0);
    /** @type {?SDK.DOMNode} */
    this._previousTarget = null;
    UI.context.addFlavorChangeListener(SDK.DOMNode, this._onSelectedNodeChanged, this);
  }

  /**
   * @param {string} text
   * @return {!Array.<string>}
   */
  _splitTextIntoClasses(text) {
    return text.split(/[.,\s]/)
      .map(className => className.trim())
      .filter(className => className.length);
  }

  /**
   * @param {!Event} event
   */
  _onKeyDown(event) {
    if (!isEnterKey(event) && !isEscKey(event))
      return;

    if (isEnterKey(event)) {
      event.consume(true);
      if (this._prompt.acceptAutoComplete())
        return;
    }

    var text = event.target.textContent;
    if (isEscKey(event)) {
      if (!text.isWhitespace())
        event.consume(true);
      text = '';
    }

    this._prompt.clearAutocomplete();
    event.target.textContent = '';

    var node = UI.context.flavor(SDK.DOMNode);
    if (!node)
      return;

    var classNames = this._splitTextIntoClasses(text);
    for (var className of classNames)
      this._toggleClass(node, className, true);
    this._installNodeClasses(node);
    this._update();
  }

  _onTextChanged() {
    var node = UI.context.flavor(SDK.DOMNode);
    if (!node)
      return;
    this._installNodeClasses(node);
  }

  /**
   * @param {!Common.Event} event
   */
  _onDOMMutated(event) {
    var node = /** @type {!SDK.DOMNode} */ (event.data);
    if (this._mutatingNodes.has(node))
      return;
    delete node[Elements.ClassesPaneWidget._classesSymbol];
    this._update();
  }

  /**
   * @param {!Common.Event} event
   */
  _onSelectedNodeChanged(event) {
    if (this._previousTarget && this._prompt.text()) {
      this._input.textContent = '';
      this._installNodeClasses(this._previousTarget);
    }
    this._previousTarget = /** @type {?SDK.DOMNode} */ (event.data);
    this._update();
  }

  /**
   * @override
   */
  wasShown() {
    this._update();
  }

  _update() {
    if (!this.isShowing())
      return;

    var node = UI.context.flavor(SDK.DOMNode);
    if (node)
      node = node.enclosingElementOrSelf();

    this._classesContainer.removeChildren();
    this._input.disabled = !node;

    if (!node)
      return;

    var classes = this._nodeClasses(node);
    var keys = classes.keysArray();
    keys.sort(String.caseInsensetiveComparator);
    for (var i = 0; i < keys.length; ++i) {
      var className = keys[i];
      var label = UI.CheckboxLabel.create(className, classes.get(className));
      label.classList.add('monospace');
      label.checkboxElement.addEventListener('click', this._onClick.bind(this, className), false);
      this._classesContainer.appendChild(label);
    }
  }

  /**
   * @param {string} className
   * @param {!Event} event
   */
  _onClick(className, event) {
    var node = UI.context.flavor(SDK.DOMNode);
    if (!node)
      return;
    var enabled = event.target.checked;
    this._toggleClass(node, className, enabled);
    this._installNodeClasses(node);
  }

  /**
   * @param {!SDK.DOMNode} node
   * @return {!Map<string, boolean>}
   */
  _nodeClasses(node) {
    var result = node[Elements.ClassesPaneWidget._classesSymbol];
    if (!result) {
      var classAttribute = node.getAttribute('class') || '';
      var classes = classAttribute.split(/\s/);
      result = new Map();
      for (var i = 0; i < classes.length; ++i) {
        var className = classes[i].trim();
        if (!className.length)
          continue;
        result.set(className, true);
      }
      node[Elements.ClassesPaneWidget._classesSymbol] = result;
    }
    return result;
  }

  /**
   * @param {!SDK.DOMNode} node
   * @param {string} className
   * @param {boolean} enabled
   */
  _toggleClass(node, className, enabled) {
    var classes = this._nodeClasses(node);
    classes.set(className, enabled);
  }

  /**
   * @param {!SDK.DOMNode} node
   */
  _installNodeClasses(node) {
    var classes = this._nodeClasses(node);
    var activeClasses = new Set();
    for (var className of classes.keys()) {
      if (classes.get(className))
        activeClasses.add(className);
    }

    var additionalClasses = this._splitTextIntoClasses(this._prompt.textWithCurrentSuggestion());
    for (className of additionalClasses)
      activeClasses.add(className);

    var newClasses = activeClasses.valuesArray();
    newClasses.sort();

    this._pendingNodeClasses.set(node, newClasses.join(' '));
    this._updateNodeThrottler.schedule(this._flushPendingClasses.bind(this));
  }

  /**
   * @return {!Promise}
   */
  _flushPendingClasses() {
    var promises = [];
    for (var node of this._pendingNodeClasses.keys()) {
      this._mutatingNodes.add(node);
      var promise = node.setAttributeValuePromise('class', this._pendingNodeClasses.get(node)).then(onClassValueUpdated.bind(this, node));
      promises.push(promise);
    }
    this._pendingNodeClasses.clear();
    return Promise.all(promises);

    /**
     * @param {!SDK.DOMNode} node
     * @this {Elements.ClassesPaneWidget}
     */
    function onClassValueUpdated(node) {
      this._mutatingNodes.delete(node);
    }
  }
};

Elements.ClassesPaneWidget._classesSymbol = Symbol('Elements.ClassesPaneWidget._classesSymbol');

/**
 * @implements {UI.ToolbarItem.Provider}
 * @unrestricted
 */
Elements.ClassesPaneWidget.ButtonProvider = class {
  constructor() {
    this._button = new UI.ToolbarToggle(Common.UIString('Element Classes'), '');
    this._button.setText('.cls');
    this._button.element.classList.add('monospace');
    this._button.addEventListener(UI.ToolbarButton.Events.Click, this._clicked, this);
    this._view = new Elements.ClassesPaneWidget();
  }

  _clicked() {
    Elements.ElementsPanel.instance().showToolbarPane(!this._view.isShowing() ? this._view : null, this._button);
  }

  /**
   * @override
   * @return {!UI.ToolbarItem}
   */
  item() {
    return this._button;
  }
};

/**
 * @unrestricted
 */
Elements.ClassesPaneWidget.ClassNamePrompt = class extends UI.TextPrompt {
  constructor() {
    super();
    this.initialize(this._buildClassNameCompletions.bind(this), ' ');
    this.disableDefaultSuggestionForEmptyInput();
    this._selectedFrameId = '';
    this._classNamesPromise = null;
  }

  /**
   * @param {!SDK.DOMNode} selectedNode
   * @return {!Promise.<!Array.<string>>}
   */
  _getClassNames(selectedNode) {
    var promises = [];
    var completions = new Set();
    this._selectedFrameId = selectedNode.frameId();

    var cssModel = selectedNode.domModel().cssModel();
    var allStyleSheets = cssModel.allStyleSheets();
    for (var stylesheet of allStyleSheets) {
      if (stylesheet.frameId !== this._selectedFrameId)
        continue;
      var cssPromise = cssModel.classNamesPromise(stylesheet.id).then(classes => completions.addAll(classes));
      promises.push(cssPromise);
    }

    var domPromise = selectedNode.domModel()
                         .classNamesPromise(selectedNode.ownerDocument.id)
                         .then(classes => completions.addAll(classes));
    promises.push(domPromise);
    return Promise.all(promises).then(() => completions.valuesArray());
  }

  /**
   * @param {string} expression
   * @param {string} prefix
   * @param {boolean=} force
   * @return {!Promise<!UI.SuggestBox.Suggestions>}
   */
  _buildClassNameCompletions(expression, prefix, force) {
    if (!prefix || force)
      this._classNamesPromise = null;

    var selectedNode = UI.context.flavor(SDK.DOMNode);
    if (!selectedNode || (!prefix && !force && !expression.trim()))
      return Promise.resolve([]);

    if (!this._classNamesPromise || this._selectedFrameId !== selectedNode.frameId())
      this._classNamesPromise = this._getClassNames(selectedNode);

    return this._classNamesPromise.then(completions => {
      if (prefix[0] === '.')
        completions = completions.map(value => '.' + value);
      return completions.filter(value => value.startsWith(prefix)).map(completion => ({text: completion}));
    });
  }
};
