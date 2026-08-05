# Privacy Policy — KAM Volume Booster

_Last updated: 5 August 2026_

## Summary

KAM Volume Booster does not collect, transmit, or sell any data. It has no
analytics, no telemetry, no accounts, and makes no network requests of any kind.

## What is stored

One number per website: the boost level you chose for that site (for example,
`250` for `https://www.youtube.com`).

This is kept in `chrome.storage.local`, which lives on your own computer. It is
stored so that a site keeps your preferred volume when you reload the page or
restart the browser. Setting a site back to 100% deletes its entry.

Nothing else is stored. The extension does not record page contents, URLs you
visit, browsing history, audio, or any personal information.

## What is never done

- No data is sent to the developer or to any third party.
- No data leaves your device.
- Audio is processed entirely locally, in your browser, in real time. It is
  never recorded, buffered to disk, or transmitted.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| `storage` | Save your chosen boost level per site, locally. |
| `activeTab`, `scripting` | Apply the boost to the tab you're currently on when you use the popup. |
| `tabs` | Identify which tab the popup is controlling, and detect pages where boosting isn't possible (`chrome://`, the Web Store) so the UI can say so. |
| `host_permissions: <all_urls>` | Audio can be on any website, and a media player is often inside a third-party iframe. The extension has no way to know in advance which sites you'll want to boost. It only ever reads and modifies audio output — it does not read page content. |

## Removing your data

Uninstalling the extension removes everything it has stored. You can also clear
individual sites by setting them back to 100%.

## Contact

Open an issue on the project's GitHub repository.
