/*****************************************************************************/
/* Imports */
/*****************************************************************************/
var debug = Iron.utils.debug('iron:dynamic-template');
var assert = Iron.utils.assert;
var camelCase = Iron.utils.camelCase;

/*****************************************************************************/
/* Private */
/*****************************************************************************/
var typeOf = function (value) {
  return Object.prototype.toString.call(value);
};

/*****************************************************************************/
/* DynamicTemplate */
/*****************************************************************************/

/**
 * Render a component to the page whose template and data context can change
 * dynamically, either from code or from helpers.
 *
 */
DynamicTemplate = function (options) {
  this.options = options = options || {};
  this._template = options.template;
  this._defaultTemplate = options.defaultTemplate;
  this._content = options.content;
  this._data = options.data;
  this._templateDep = new Tracker.Dependency;
  this._dataDep = new Tracker.Dependency;
  this._hasControllerDep = new Tracker.Dependency;
  this._hooks = {};
  this._eventMap = null;
  this._eventHandles = null;
  this._eventThisArg = null;
  this._controller = new ReactiveVar; 
  this.name = options.name || this.constructor.name || 'DynamicTemplate';

  // has the Blaze.View been created?
  this.isCreated = false;

  // has the Blaze.View been destroyed and not created again?
  this.isDestroyed = false;
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

  if (arguments.length > 0)
    return;

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
 * Create the view if it hasn't been created yet.
 */
DynamicTemplate.prototype.create = function (options) {
  var self = this;

  if (this.isCreated) {
    throw new Error("DynamicTemplate view is already created");
  }

  this.isCreated = true;
  this.isDestroyed = false;

  var templateVar = ReactiveVar(null);

  var view = Blaze.View('DynamicTemplate', function () {
    var thisView = this;

    // create the template dependency here because we need the entire
    // dynamic template to re-render if the template changes, including
    // the Blaze.With view.
    var template = templateVar.get();

    return Blaze.With(function () {
      // NOTE: This will rerun anytime the data function invalidates this
      // computation OR if created from an inclusion helper (see note below) any
      // time any of the argument functions invlidate the computation. For
      // example, when the template changes this function will rerun also. But
      // it's probably generally ok. The more serious use case is to not
      // re-render the entire template every time the data context changes.
      var result = self.data();

      if (typeof result !== 'undefined')
        // looks like data was set directly on this dynamic template
        return result;
      else
        // return the first parent data context that is not inclusion arguments
        return DynamicTemplate.getParentDataContext(thisView);
    }, function () {
      // NOTE: When DynamicTemplate is used from a template inclusion helper
      // like this {{> DynamicTemplate template=getTemplate data=getData}} the
      // function below will rerun any time the getData function invalidates the
      // argument data computation.
      var tmpl = null;

      // is it a template name like "MyTemplate"?
      if (typeof template === 'string') {
        tmpl = Template[template];

        if (!tmpl)
          // as a fallback double check the user didn't actually define
          // a camelCase version of the template.
          tmpl = Template[camelCase(template)];

        if (!tmpl) {
          tmpl = Blaze.With({
            msg: "Couldn't find a template named " + JSON.stringify(template) + " or " + JSON.stringify(camelCase(template))+ ". Are you sure you defined it?"
          }, function () {
            return Template.__DynamicTemplateError__;
          });
        }
      } else if (typeOf(template) === '[object Object]') {
        // or maybe a view already?
        tmpl = template;
      } else if (typeof self._content !== 'undefined') {
        // or maybe its block content like 
        // {{#DynamicTemplate}}
        //  Some block
        // {{/DynamicTemplate}}
        tmpl = self._content;
      }

      return tmpl;
    });
  });

  view.onViewCreated(function () {
    this.autorun(function () {
      templateVar.set(self.template());
    });
  });

  // wire up the view lifecycle callbacks
  _.each(['onViewCreated', 'onViewReady', '_onViewRendered', 'onViewDestroyed'], function (hook) {
    view[hook](function () {
      // "this" is the view instance
      self._runHooks(hook, this);
    });
  });

  view._onViewRendered(function () {
    // avoid inserting the view twice by accident.
    self.isInserted = true;

    if (view.renderCount !== 1)
      return;

    self._attachEvents();
  });

  view._templateInstance = new Blaze.TemplateInstance(view);
  view.templateInstance = function () {
    // Update data, firstNode, and lastNode, and return the TemplateInstance
    // object.
    var inst = view._templateInstance;

    inst.data = Blaze.getData(view);

    if (view._domrange && !view.isDestroyed) {
      inst.firstNode = view._domrange.firstNode();
      inst.lastNode = view._domrange.lastNode();
    } else {
      // on 'created' or 'destroyed' callbacks we don't have a DomRange
      inst.firstNode = null;
      inst.lastNode = null;
    }

    return inst;
  };

  this.view = view;
  view.__dynamicTemplate__ = this;

  var controller = Deps.nonreactive(function () {
    return self.getController();
  });

  if (controller)
    DynamicTemplate.registerLookupHost(view, controller);

  //XXX change to this.constructor.name?
  view.name = this.name;
  return view;
};

/**
 * Destroy the dynamic template, also destroying the view if it exists.
 */
DynamicTemplate.prototype.destroy = function () {
  if (this.isCreated) {
    Blaze.remove(this.view);
    this.view = null;
    this.isDestroyed = true;
    this.isCreated = false;
  }
};

/**
 * View lifecycle hooks.
 */
_.each(['onViewCreated', 'onViewReady', '_onViewRendered', 'onViewDestroyed'], function (hook) {
  DynamicTemplate.prototype[hook] = function (cb) {
    var hooks = this._hooks[hook] = this._hooks[hook] || [];
    hooks.push(cb);
    return this;
  };
});

DynamicTemplate.prototype._runHooks = function (name, view) {
  var hooks = this._hooks[name] || [];
  var hook;

  for (var i = 0; i < hooks.length; i++) {
    hook = hooks[i];
    // keep the "thisArg" pointing to the view, but make the first parameter to
    // the callback teh dynamic template instance.
    hook.call(view, this);
  }
};

DynamicTemplate.prototype.events = function (eventMap, thisInHandler) {
  var self = this;

  this._detachEvents();
  this._eventThisArg = thisInHandler;

  var boundMap = this._eventMap = {};

  for (var key in eventMap) {
    boundMap[key] = (function (key, handler) {
      return function (e) {
        var data = Blaze.getData(e.currentTarget);
        if (data == null) data = {};
        var tmplInstance = self.view.templateInstance();
        return handler.call(thisInHandler || this, e, tmplInstance, data);
      }
    })(key, eventMap[key]);
  }

  this._attachEvents();
};

DynamicTemplate.prototype._attachEvents = function () {
  var self = this;
  var thisArg = self._eventThisArg;
  var boundMap = self._eventMap;
  var view = self.view;
  var handles = self._eventHandles;

  if (!view)
    return;

  var domrange = view._domrange;

  if (!domrange)
    throw new Error("no domrange");

  var attach = function (range, element) {
    _.each(boundMap, function (handler, spec) {
      var clauses = spec.split(/,\s+/);
      // iterate over clauses of spec, e.g. ['click .foo', 'click .bar']
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        var newEvents = parts.shift();
        var selector = parts.join(' ');
        handles.push(Blaze._EventSupport.listen(
          element, newEvents, selector,
          function (evt) {
            if (! range.containsElement(evt.currentTarget))
              return null;
            var handlerThis = self._eventThisArg || this;
            var handlerArgs = arguments;
            return Blaze._withCurrentView(view, function () {
              return handler.apply(handlerThis, handlerArgs);
            });
          },
          range, function (r) {
            return r.parentRange;
          }));
      });
    });
  };

  if (domrange.attached)
    attach(domrange, domrange.parentElement);
  else
    domrange.onAttached(attach);
};

DynamicTemplate.prototype._detachEvents = function () {
  _.each(this._eventHandles, function (h) { h.stop(); });
  this._eventHandles = [];
};

var attachEventMaps = function (range, element, eventMap, thisInHandler) {
  _.each(eventMap, function (handler, spec) {
    var clauses = spec.split(/,\s+/);
    // iterate over clauses of spec, e.g. ['click .foo', 'click .bar']
    _.each(clauses, function (clause) {
      var parts = clause.split(/\s+/);
      if (parts.length === 0)
        return;

      var newEvents = parts.shift();
      var selector = parts.join(' ');
      handles.push(Blaze._EventSupport.listen(
        element, newEvents, selector,
        function (evt) {
          if (! range.containsElement(evt.currentTarget))
            return null;
          var handlerThis = thisInHandler || this;
          var handlerArgs = arguments;
          return Blaze._withCurrentView(view, function () {
            return handler.apply(handlerThis, handlerArgs);
          });
        },
        range, function (r) {
          return r.parentRange;
        }));
    });
  });
};

/**
 * Insert the Layout view into the dom.
 */
DynamicTemplate.prototype.insert = function (options) {
  options = options || {};

  if (this.isInserted)
    return;
  this.isInserted = true;

  var el = options.el || document.body;
  var $el = $(el);

  if ($el.length === 0)
    throw new Error("No element to insert layout into. Is your element defined? Try a Meteor.startup callback.");

  if (!this.view)
    this.create(options);

  Blaze.render(this.view, $el[0], options.nextNode, options.parentView);

  return this;
};

/**
 * Reactively return the value of the current controller.
 */
DynamicTemplate.prototype.getController = function () {
  return this._controller.get();
};

/**
 * Set the reactive value of the controller.
 */
DynamicTemplate.prototype.setController = function (controller) {
  var didHaveController = !!this._hasController;
  this._hasController = (typeof controller !== 'undefined');

  if (didHaveController !== this._hasController)
    this._hasControllerDep.changed();

  // this will not invalidate an existing view so this lookup host
  // will only be looked up on subsequent renderings.
  if (this.view)
    DynamicTemplate.registerLookupHost(this.view, controller);

  return this._controller.set(controller);
};

/**
 * Reactively returns true if the template has a controller and false otherwise.
 */
DynamicTemplate.prototype.hasController = function () {
  this._hasControllerDep.depend();
  return this._hasController;
};

/*****************************************************************************/
/* DynamicTemplate Static Methods */
/*****************************************************************************/

/**
 * Get the first parent data context that are not inclusion arguments
 * (see above function). Note: This function can create reactive dependencies.
 */
DynamicTemplate.getParentDataContext = function (view) {
  // start off with the parent.
  view = view.parentView;

  while (view) {
    if (view.name === 'with' && !view.__isTemplateWith)
      return view.dataVar.get();
    else
      view = view.parentView;
  }

  return null;
};


/**
 * Get inclusion arguments, if any, from a view.
 *
 * Uses the __isTemplateWith property set when a parent view is used
 * specificially for a data context with inclusion args.
 *
 * Inclusion arguments are arguments provided in a template like this:
 * {{> yield "inclusionArg"}}
 * or
 * {{> yield region="inclusionArgValue"}}
 */
DynamicTemplate.getInclusionArguments = function (view) {
  var parent = view && view.parentView;

  if (!parent)
    return null;

  if (parent.__isTemplateWith)
    return parent.dataVar.get();

  return null;
};

/**
 * Given a view, return a function that can be used to access argument values at
 * the time the view was rendered. There are two key benefits:
 *
 * 1. Save the argument data at the time of rendering. When you use lookup(...)
 *    it starts from the current data context which can change.
 * 2. Defer creating a dependency on inclusion arguments until later.
 *
 * Example:
 *
 *   {{> MyTemplate template="MyTemplate"
 *   var args = DynamicTemplate.args(view);
 *   var tmplValue = args('template');
 *     => "MyTemplate"
 */
DynamicTemplate.args = function (view) {
  return function (key) {
    var data = DynamicTemplate.getInclusionArguments(view);

    if (data) {
      if (key)
        return data[key];
      else
        return data;
    }

    return null;
  };
};

/**
 * Inherit from DynamicTemplate.
 */
DynamicTemplate.extend = function (props) {
  return Iron.utils.extend(this, props);
};

/**
 * Register a lookupHost for a view. This allows components and controllers
 * to participate in the Blaze.prototype.lookup chain.
 */
DynamicTemplate.registerLookupHost = function (target, host) {
  assert(typeof target == 'object', 'registerLookupHost requires the target to be an object');
  assert(typeof host == 'object', 'registerLookupHost requires the host to be an object');
  target.__lookupHost__ = host;
};

/**
 * Returns true if the target is a lookup host and false otherwise.
 */
DynamicTemplate.isLookupHost = function (target) {
  return !!(target && target.__lookupHost__);
};

/*
 * Returns the lookup host for the target or undefined if it doesn't exist.
 */
DynamicTemplate.getLookupHost = function (target) {
  return target && target.__lookupHost__;
};

/*****************************************************************************/
/* UI Helpers */
/*****************************************************************************/

if (typeof Template !== 'undefined') {
  UI.registerHelper('DynamicTemplate', new Template('DynamicTemplateHelper', function () {
    var args = DynamicTemplate.args(this);

    return new DynamicTemplate({
      data: function () { return args('data'); },
      template: function () { return args('template'); },
      content: this.templateContentBlock
    }).create();
  }));

  /**
   * Find a lookup host with a state key and return it reactively if we have
   * it.
   */
  UI.registerHelper('get', function (key) {
    var view = Blaze.getView();
    var host;

    while (view) {
      if (host = DynamicTemplate.getLookupHost(view)) {
        return host.state && host.state.get(key);
      } else {
        view = view.parentView;
      }
    }

    return undefined;
  });
}

/*****************************************************************************/
/* Namespacing */
/*****************************************************************************/
Iron.DynamicTemplate = DynamicTemplate;
