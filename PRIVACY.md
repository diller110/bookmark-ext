# Bookmark Shelf Privacy Policy

Last updated: October 26, 2026.

Bookmark Shelf does not send your bookmarks, resource library or usage data to the developer. It has no analytics, advertising, developer-operated server or account system. Your data is not sold or used for advertising.

## Data used by the extension

The extension reads Chrome bookmarks and tab URLs to display your bookmark folders, associate resources with bookmarks and show resource counts. When you search a page for resources, it reads media information from that page and its permitted frames. It does not keep a separate browsing-history log or use Chrome's history API.

Resource files, bookmark metadata, tags, collections, thumbnails and timelapses are stored in the resource folder you choose. Settings, folder access handles, download queues and interface state are stored locally in your Chrome profile. Download URLs may contain access tokens provided by the source website.

The extension does not encrypt these files itself. If you choose a cloud-synced folder or network drive, its contents may be transferred by that service.

## Requests to other websites

Finding file sizes, displaying previews and downloading resources can make requests to source websites and their content delivery networks. These sites receive your IP address, requested URLs and normal request information. Requests may include applicable browser cookies when needed to access a resource. Cookie values are not read through a cookies API or sent to the developer.

Starting a YouTube preview loads YouTube's embedded player. Google receives the video request, network information, the extension's identifier and any cookies permitted by your browser. The player is subject to [Google's Privacy Policy](https://policies.google.com/privacy). YouTube downloads are not supported.

Website icons are obtained through Chrome's favicon mechanism. The extension supports HTTP and HTTPS resource URLs; HTTP traffic is not encrypted.

## Incognito mode

If you enable the extension in incognito mode, it uses the same resource folder, library and preview cache as regular mode. Resources and metadata saved from incognito remain after the private window closes. Download queues are separate.

## Your control

You can revoke website access in Chrome's extension settings. Uninstalling the extension removes its browser-managed storage, but does not delete your Chrome bookmarks or files in your chosen resource folder. Delete that folder, including its catalog and caches, to remove the disk library. Removing a bookmark does not automatically delete its resource files.
