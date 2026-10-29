import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";

export async function openSettingsMenu(
  ctx: ExtensionContext,
  items: SettingItem[],
  onChange: (id: string, newValue: string) => Promise<void>,
): Promise<void> {
  let pending = Promise.resolve();
  await ctx.ui.custom((tui, _theme, _keybindings, done) => {
    const savedValues = new Map(items.map((item) => [item.id, item.currentValue]));
    const revisions = new Map<string, number>();
    const container = new Container();
    container.addChild(new DynamicBorder());

    const settingsList = new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      (id, newValue) => {
        const revision = (revisions.get(id) ?? 0) + 1;
        revisions.set(id, revision);
        // SettingsList does not await callbacks. Serialize edits and contain
        // rejections here rather than leaving an unhandled promise in the UI.
        pending = pending.then(async () => {
          try {
            await onChange(id, newValue);
            savedValues.set(id, newValue);
          } catch (error) {
            ctx.ui.notify(`Settings change failed: ${String(error)}`, "error");
          }
          // Older completions must not overwrite a newer pending UI selection.
          if (revisions.get(id) === revision) {
            settingsList.updateValue(id, savedValues.get(id)!);
          }
          tui.requestRender();
        });
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(settingsList);
    container.addChild(new DynamicBorder());

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
  await pending;
}
