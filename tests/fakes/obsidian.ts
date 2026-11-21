/**
 * Stand-in for the "obsidian" module in tests (the npm package only ships types). Only what the
 * settings tab uses is here.
 *
 * Obsidian's Setting and its components have a chaining then(cb) that calls cb(this) and returns this.
 * That makes them thenables: a promise resolved with one calls then() again, forever, in microtasks,
 * and Obsidian freezes (issue #4). These fakes behave the same, but give up after `cap` calls so a
 * regression fails the test instead of hanging it.
 */
export const fake = { thenCalls: 0, cap: 100, settings: [] as Setting[] };

export function resetFake(): void {
  fake.thenCalls = 0;
  fake.settings.length = 0;
}

class Chainable {
  then(cb: (self: this) => unknown): this {
    if (++fake.thenCalls > fake.cap) throw new Error("a promise adopted an Obsidian component");
    cb(this);
    return this;
  }
}

/** A button, dropdown, toggle or text field: every setter returns the control itself. */
function control(): unknown {
  const self: unknown = new Proxy(new Chainable(), {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => self),
  });
  return self;
}

export class Setting extends Chainable {
  name = "";
  descs: string[] = [];

  constructor(readonly containerEl: HTMLElement) {
    super();
    fake.settings.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descs.push(desc);
    return this;
  }

  setHeading(): this {
    return this;
  }

  setClass(): this {
    return this;
  }

  addButton(cb: (c: unknown) => unknown): this {
    cb(control());
    return this;
  }

  addExtraButton(cb: (c: unknown) => unknown): this {
    cb(control());
    return this;
  }

  addDropdown(cb: (c: unknown) => unknown): this {
    cb(control());
    return this;
  }

  addToggle(cb: (c: unknown) => unknown): this {
    cb(control());
    return this;
  }

  addText(cb: (c: unknown) => unknown): this {
    cb(control());
    return this;
  }

  addComponent(cb: (el: HTMLElement) => unknown): this {
    cb(document.createElement("div"));
    return this;
  }
}

export class PluginSettingTab {
  containerEl = Object.assign(document.createElement("div"), {
    empty(this: HTMLElement) {
      this.replaceChildren();
    },
  });

  constructor(
    readonly app: unknown,
    readonly plugin: unknown,
  ) {}
}

export class SecretComponent extends Chainable {
  setValue(): this {
    return this;
  }

  onChange(): this {
    return this;
  }
}

export class Notice {}
