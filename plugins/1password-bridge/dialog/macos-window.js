// Native approval window (JXA). Usage: osascript -l JavaScript macos-window.js '<json>' [png]
// json: { title, reason, rows: [[label, value, mono?], ...], commands: [{ short, full, cwd, literal }],
// labels: { command, literal, expand }, approve, deny }, where approve and deny are the button
// labels. Prints "approve" or "deny". A command shows collapsed (its first line); "expand" swaps in
// the whole text in a scrolling box.
// A compact panel rather than NSAlert: the icon sits beside the title instead of above it, the
// details follow, and the reason closes the window in its own tinted pill.
// The approve button has no key equivalent on purpose: a window that pops up while the user types
// must not be approved by a stray Return. Escape denies.
ObjC.import('Cocoa');

const APPROVE = 1000;
const DENY = 1001;
const PAD = 18;
const PILL_X = 10;
const PILL_Y = 7;
const CODE_MAX_HEIGHT = 240;
// expand: looks a command up by its button's tag.
const expanders = [];

ObjC.registerSubclass({
  name: 'GrantTarget',
  methods: {
    'approve:': {
      types: ['void', ['id']],
      implementation: function () { $.NSApplication.sharedApplication.stopModalWithCode(APPROVE); },
    },
    'deny:': {
      types: ['void', ['id']],
      implementation: function () { $.NSApplication.sharedApplication.stopModalWithCode(DENY); },
    },
    'expand:': {
      types: ['void', ['id']],
      implementation: function (sender) {
        const e = expanders[Number(sender.tag)];
        e.short.hidden = true;
        e.button.hidden = true;
        e.full.hidden = false;
        const panel = e.full.window;
        // setContentSize keeps the bottom-left corner, so the window would grow upwards and could
        // leave the screen; pin the top-left corner instead so it grows downwards.
        const frame = panel.frame;
        const topLeft = $.NSMakePoint(frame.origin.x, frame.origin.y + frame.size.height);
        panel.setContentSize(panel.contentView.fittingSize);
        panel.setFrameTopLeftPoint(topLeft);
      },
    },
  },
});

function label(text, opts) {
  const f = $.NSTextField.labelWithString($(text));
  f.font = opts.mono
    ? $.NSFont.monospacedSystemFontOfSizeWeight(11, 0)
    : $.NSFont.systemFontOfSize(opts.size || 12);
  if (opts.secondary) f.textColor = $.NSColor.secondaryLabelColor;
  if (opts.selectable) f.selectable = true;
  return f;
}

function views(list) {
  // Nested JS arrays do not bridge to NSArray<NSView>; build them explicitly.
  const a = $.NSMutableArray.array;
  for (const v of list) a.addObject(v);
  return a;
}

function fixSize(view, width, height) {
  if (width != null) view.widthAnchor.constraintEqualToConstant(width).active = true;
  if (height != null) view.heightAnchor.constraintEqualToConstant(height).active = true;
}

function codeBox(text, width) {
  const view = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, width, CODE_MAX_HEIGHT));
  view.editable = false;
  view.selectable = true;
  view.drawsBackground = false;
  view.font = $.NSFont.monospacedSystemFontOfSizeWeight(11, 0);
  view.string = $(text);
  view.verticallyResizable = true;
  view.horizontallyResizable = false;
  view.autoresizingMask = $.NSViewWidthSizable;
  view.textContainer.widthTracksTextView = true;
  view.layoutManager.ensureLayoutForTextContainer(view.textContainer);
  const used = view.layoutManager.usedRectForTextContainer(view.textContainer).size.height;
  const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, width, CODE_MAX_HEIGHT));
  scroll.hasVerticalScroller = true;
  scroll.drawsBackground = false;
  scroll.documentView = view;
  fixSize(scroll, width, Math.min(Math.ceil(used) + 4, CODE_MAX_HEIGHT));
  return scroll;
}

function commandView(cmd, index, width, target, labels) {
  const head = label(`${cmd.literal ? labels.literal : labels.command} · ${cmd.cwd}`, { secondary: true, size: 11 });
  const short = label(cmd.short, { mono: true, selectable: true });
  short.lineBreakMode = $.NSLineBreakByTruncatingTail;
  // The label's natural one-line width, measured before it is pinned to `width`: a wider line is
  // cut with an ellipsis there, so it needs the expand control even when it is the whole command.
  const truncated = short.intrinsicContentSize.width > width;
  fixSize(short, width, null);
  const parts = [head, short];
  if (truncated || cmd.short !== cmd.full) {
    const full = codeBox(cmd.full, width);
    full.hidden = true;
    const button = $.NSButton.buttonWithTitleTargetAction($(labels.expand), target, 'expand:');
    button.controlSize = $.NSControlSizeSmall;
    button.tag = index;
    expanders[index] = { short, full, button };
    parts.push(full, button);
  }
  const stack = $.NSStackView.stackViewWithViews(views(parts));
  stack.orientation = $.NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = $.NSLayoutAttributeLeading;
  stack.spacing = 3;
  return stack;
}

function run(argv) {
  const data = JSON.parse(argv[0]);
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  const icon = $.NSImageView.imageViewWithImage(
    $.NSWorkspace.sharedWorkspace.iconForFile($('/Applications/1Password.app')));
  fixSize(icon, 34, 34);
  const title = label(data.title, {});
  title.font = $.NSFont.boldSystemFontOfSize(13);
  const header = $.NSStackView.stackViewWithViews(views([icon, title]));
  header.spacing = 10;
  header.alignment = $.NSLayoutAttributeCenterY;

  const rows = $.NSMutableArray.array;
  for (const [k, v, mono] of data.rows) {
    rows.addObject(views([
      label(k, { secondary: true, size: 11 }),
      label(v, { mono: Boolean(mono), selectable: true }),
    ]));
  }
  const grid = $.NSGridView.gridViewWithViews(rows);
  grid.rowSpacing = 3;
  grid.columnSpacing = 10;
  grid.columnAtIndex(0).xPlacement = $.NSGridCellPlacementTrailing;
  grid.rowAlignment = $.NSGridRowAlignmentFirstBaseline;
  // Pinned to its natural width: the stack stretches it to `inner` otherwise, and which column
  // takes the spare width is then left to chance (a wide collapsed command pushed the values right).
  const gridWidth = grid.fittingSize.width;
  fixSize(grid, gridWidth, null);
  const inner = Math.max(gridWidth, data.commands.length > 0 ? 520 : 360);

  const target = $.GrantTarget.alloc.init;
  const reason = $.NSTextField.wrappingLabelWithString($(data.reason));
  reason.font = $.NSFont.systemFontOfSize(12);
  reason.selectable = true;
  reason.preferredMaxLayoutWidth = inner - 2 * PILL_X;
  const pill = $.NSBox.alloc.init;
  pill.boxType = $.NSBoxCustom;
  pill.titlePosition = $.NSNoTitle;
  pill.borderWidth = 0;
  pill.cornerRadius = 8;
  pill.fillColor = $.NSColor.controlAccentColor.colorWithAlphaComponent(0.16);
  pill.contentViewMargins = $.NSMakeSize(PILL_X, PILL_Y);
  pill.contentView = reason;
  fixSize(pill, inner, reason.fittingSize.height + 2 * PILL_Y);

  const commands = data.commands.map((cmd, i) => commandView(cmd, i, inner, target, data.labels));

  const deny = $.NSButton.buttonWithTitleTargetAction($(data.deny), target, 'deny:');
  deny.keyEquivalent = $('\x1b');
  const approve = $.NSButton.buttonWithTitleTargetAction($(data.approve), target, 'approve:');
  const buttons = $.NSStackView.alloc.init;
  buttons.setViewsInGravity(views([deny, approve]), $.NSStackViewGravityTrailing);
  fixSize(buttons, inner, null);

  const stack = $.NSStackView.stackViewWithViews(views([header, grid, pill, ...commands, buttons]));
  stack.orientation = $.NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = $.NSLayoutAttributeLeading;
  stack.spacing = 12;
  stack.setCustomSpacingAfterView(14, commands.length > 0 ? commands[commands.length - 1] : pill);
  stack.edgeInsets = { top: PAD, left: PAD, bottom: PAD - 2, right: PAD };

  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, inner + 2 * PAD, 200),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskFullSizeContentView,
    $.NSBackingStoreBuffered, false);
  panel.titlebarAppearsTransparent = true;
  panel.titleVisibility = $.NSWindowTitleHidden;
  panel.movableByWindowBackground = true;
  for (const b of [$.NSWindowCloseButton, $.NSWindowMiniaturizeButton, $.NSWindowZoomButton]) {
    panel.standardWindowButton(b).hidden = true;
  }
  panel.contentView = stack;
  panel.setContentSize(stack.fittingSize);
  panel.center;

  if (argv[1]) {
    // Layout check: render the content to a PNG at argv[1] instead of showing the window. The
    // light appearance keeps the text dark on the PNG's transparent background.
    panel.appearance = $.NSAppearance.appearanceNamed($.NSAppearanceNameAqua);
    stack.layoutSubtreeIfNeeded;
    const rep = stack.bitmapImageRepForCachingDisplayInRect(stack.bounds);
    stack.cacheDisplayInRectToBitmapImageRep(stack.bounds, rep);
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
      .writeToFileAtomically($(argv[1]), true);
    return `rendered ${stack.bounds.size.width}x${stack.bounds.size.height}`;
  }

  app.activateIgnoringOtherApps(true);
  panel.makeKeyAndOrderFront(null);
  const code = app.runModalForWindow(panel);
  panel.orderOut(null);
  // JXA returns the modal response code as a string ("1000"), so compare it as a number.
  return Number(code) === APPROVE ? 'approve' : 'deny';
}
