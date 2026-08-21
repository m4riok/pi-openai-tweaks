import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";

export async function openSettingsMenu(
  ctx: ExtensionContext,
  items: SettingItem[],
  onChange: (id: string, newValue: string) => Promise<void>,
): Promise<void> {
  await ctx.ui.custom((tui, _theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder());

    const settingsList = new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      onChange,
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
}
