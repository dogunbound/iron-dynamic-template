typeOf = function (value) {
  return Object.prototype.toString.call(value);
};

findComponentWithProp = function (id, comp) {
  while (comp) {
    if (typeof comp[id] !== 'undefined')
      return comp;
    comp = comp.parent;
  }
  return null;
};

/**
 * Get inclusion arguments if any.
 *
 * Uses the __isTemplateWith property set when a parent component is used
 * specificially for a data context with inclusion args.
 *
 * Inclusion arguments are arguments provided in a template like this:
 * {{> yield "inclusionArg"}}
 * or
 * {{> yield region="inclusionArgValue"}}
 */
getInclusionArguments = function (cmp) {
  var parent = cmp && cmp.parent;

  if (!parent)
    return null;

  if (parent.__isTemplateWith && parent.data)
    return (typeof parent.data === 'function') ? parent.data() : parent.data;

  return null;
};

/**
 * Get the first parent data context that does not include inclusion arguments
 * (see above function).
 */
getParentDataContext = function (view) {
  // start off with the parent.
  view = view.parentView;

  while (view) {
    if (view.kind === 'with' && !view.__isTemplateWith)
      return view.dataVar.get();
    else
      view = view.parentView;
  }

  return null;
};

/**
 * Render a component to the page whose template and data context can change
 * dynaimcally.
 *
 */
DynamicTemplate = function (options) {
  this.options = options = options || {};
  this._template = options.template;
  this._defaultTemplate = options.defaultTemplate;
  this._content = options.content;
  this._data = options.data;
  this._templateDep = new Deps.Dependency;
  this._dataDep = new Deps.Dependency;
  this._hooks = {};
  this.kind = options.kind || 'DynamicTemplate';
};

/**
 * Get or set the template. 
 */
DynamicTemplate.prototype.template = function (value) {
  if (arguments.length === 1 && value !== this._template) {
    this._template = value;
    this._templateDep.changed();
    return;
  }

  this._templateDep.depend();

  // do we have a template?
  if (this._template)
    return (typeof this._template === 'function') ? this._template() : this._template;

  // no template? ok let's see if we have a default one set
  if (this._defaultTemplate)
    return (typeof this._defaultTemplate === 'function') ? this._defaultTemplate() : this._defaultTemplate;
};

/**
 * Get or set the default template.
 *
 * This function does not change any dependencies.
 */
DynamicTemplate.prototype.defaultTemplate = function (value) {
  if (arguments.length === 1)
    this._defaultTemplate = value;
  else
    return this._defaultTemplate;
};


/**
 * Clear the template and data contexts.
 */
DynamicTemplate.prototype.clear = function () {
  //XXX do we need to clear dependencies here too?
  this._template = undefined;
  this._data = undefined;
  this._templateDep.changed();
};


/**
 * Get or set the data context.
 */
DynamicTemplate.prototype.data = function (value) {
  if (arguments.length === 1 && value !== this._data) {
    this._data = value;
    this._dataDep.changed();
    return;
  }

  this._dataDep.depend();
  return typeof this._data === 'function' ? this._data() : this._data;
};

/**
 * Return a UI.Component.
 * XXX add back hooks
 */
DynamicTemplate.prototype.create = function (options) {
  var self = this;

  if (this.view)
    throw new Error("view is already created");

  var view = self.view = Blaze.View(self.kind, function () {
    var template = self.template();

    // is it a template name like "MyTemplate"?
    if (typeof template === 'string') {
      var tmpl = Template[template];

      if (!tmpl)
        throw new Error("Couldn't find a template named '" + template + "'. Are you sure you defined it?");

      return tmpl;
    }

    // or maybe a component?
    if (typeOf(template) === '[object Object]')
      return template;

    // or maybe its block content like 
    // {{#DynamicTemplate}}
    //  Some block
    // {{/DynamicTemplate}}
    if (typeof self._content !== 'undefined')
      return self._content;

    // guess we don't have a template assigned yet
    return null;
  });

  view.__dynamicTemplate__ = self;

  /**
   * Return either the data which is set on the dynamic template directly, or the next
   * ancestor's data.
   */
  var dataView = Blaze.With(function () {
    var result = self.data();

    if (typeof result !== 'undefined')
      // looks like data was set directly on this dynamic template
      return result;
    else
      // return the first parent data context that is not inclusion arguments
      return getParentDataContext(dataView);
  }, function () {
    return view;
  });

  return dataView;
};

/*
 * Create a new component and call UI.render.
 */
DynamicTemplate.prototype.render = function (options) {
  options = options || {};

  if (this.range)
    throw new Error("view is already rendered");

  var range = this.range = Blaze.render(this.create(options), options.parentView);
  return range;
};

/**
 * Insert the Layout component into the dom.
 */
DynamicTemplate.prototype.insert = function (options) {
  options = options || {};

  var el = options.el || document.body;
  var $el = $(el);

  if ($el.length === 0)
    throw new Error("No element to insert layout into. Is your element defined? Try a Meteor.startup callback.");

  var range = this.render(options);
  range.attach($el[0], options.nextNode);
};

/**
 * Register a callback to be called at component render time.
 */
DynamicTemplate.prototype.onRender = function (callback) {
  var hooks = this._hooks['onRender'] = this._hooks['onRender'] || [];
  hooks.push(callback);
  return this;
};


/**
 * Run hook functions for a given hook name.
 *
 * hooks['onRender'] = [fn1, fn2, fn3]
 */
DynamicTemplate.prototype._runHooks = function (name /*, args */) {
  var args = _.toArray(arguments).slice(1);
  var hooks = this._hooks[name] || [];
  var hook;

  for (var i = 0; i < hooks.length; i++) {
    hook = hooks[i];
    hook.apply(this, args);
  }
};

/**
 * Register a global helper so users can use DynamicTemplates directly.
 *
 * NOTE: I add a component as the value instead of a function to avoid creating
 * an unnecessary reactive dependency that Meteor creates when a global helper
 * is a function. If it's an object this dependency does not get created.
 */
/*
UI.registerHelper('DynamicTemplate', function (options) {
  return Template.__create__('DynamicTemplateWrapper', function () {
    var self = this;
    debugger;
    var template = new DynamicTemplate({
      template: function () { return self.lookup('template'); },
      data: function () { return self.lookup('data'); },
      content: this.templateContentBlock
    });

    return template.create();
  });
});
*/

/*
UI.registerHelper('DynamicTemplate', Blaze.View(function () {
}));
*/

/**
 * Namespacing
 */
Iron.DynamicTemplate = DynamicTemplate;

