# Privacy Policy for Aufwieder-zen

Last updated: September 23, 2026

Aufwieder-zen is a Chrome extension that adds Unfollow and Block controls to the LinkedIn feed. It handles information from LinkedIn pages on your device so those controls can work. It does not send that information to the developer or to any other server.

## What Data We Collect

The extension handles the following, and only for the features below.

**LinkedIn page content.** On `https://www.linkedin.com`, the extension reads the feed in the page you already have open. For each post it uses the visible author name, the profile link, and the structure of the post (for example, whether it is a direct post, a repost, or a reaction). It uses that information to place Unfollow and Block on the post and to match LinkedIn’s own menu labels. It does not read your messages, your password, cookies, or LinkedIn authentication tokens.

**A profile page you ask it to open.** When you click Block, the extension opens that person’s public LinkedIn profile in a minimized window, uses LinkedIn’s own Block controls, then closes the window. The profile address is used only for that action. Query parameters on the link, including LinkedIn member identifiers, are removed before the page is opened. The address is not saved.

**Settings stored on your device.**

- Whether Unfollow and Block are shown on posts
- Whether Block is shown on the original author of a repost or reaction
- Whether the two button groups are swapped
- Whether debug mode is on
- Your language choice for the popup and buttons (English, French, or “follow the browser”)
- A count of profiles this extension has successfully blocked

The count is a number. The extension does not keep a list of people you blocked. LinkedIn keeps that list in your LinkedIn settings.

**Browser language.** If you have not chosen a language, the extension reads Chrome’s interface language once, on your device, to pick English or French. That reading is not sent anywhere.

**Debug console output.** If you turn on Debug Mode, the extension writes operational messages to the developer console in Chrome. Those messages may include a display name and the path of a profile link, such as `/in/jane`. They do not include the full profile link or member identifiers. The messages stay in your browser. They are not uploaded.

The extension does not collect health information, financial or payment information, authentication information, personal communications, location, or a browsing history of sites other than the LinkedIn page it is acting on.

## How Data Is Stored

Settings and the blocked-profile count are stored with `chrome.storage.local`. That storage stays in your Chrome profile on your device. The extension does not use `chrome.storage.sync`, so these settings are not copied to your Google account by this extension.

LinkedIn page content and profile addresses are processed in memory while a feature runs. They are not written to extension storage.

## How Data Is Used

- Feed content is used to show, label, and operate Unfollow and Block on posts.
- A profile address is used to open the matching LinkedIn profile after you click Block.
- Settings are used to remember the choices you make in the popup.
- The blocked-profile count is used to show that number in the popup.
- The browser language, or your saved language choice, is used to choose English or French for the popup and buttons.
- Debug output is used only so you can troubleshoot the extension when you have turned Debug Mode on.

The extension does not use this data for advertising, and it does not sell it.

## Permissions

The extension requests only the access those features need.

- **Storage.** Save the settings and the blocked-profile count on your device.
- **Scripting.** Run the Block steps inside the LinkedIn profile window the extension opened, after you click Block.
- **Access to `https://www.linkedin.com/`.** Read and change LinkedIn pages so the buttons can be added and so Unfollow and Block can use LinkedIn’s own controls. The extension does not request access to every website.

## Third-Party Services

This extension does not use analytics, advertising, crash reporting, or other third-party services. It does not receive information from Google APIs such as Gmail, Drive, or Calendar.

Unfollow and Block act on LinkedIn’s website in your browser, over LinkedIn’s own connection. LinkedIn’s handling of your account is covered by [LinkedIn’s Privacy Policy](https://www.linkedin.com/legal/privacy-policy). Aufwieder-zen is not affiliated with LinkedIn.

## Data Sharing

The extension does not sell, rent, or transfer your data to the developer or to any other party.

The only data movement is inside your browser: from a LinkedIn tab to the extension, and, when you click Block, back to a LinkedIn profile page so LinkedIn can apply its own block. No copy is sent to a server operated for this extension.

## Data Retention and Deletion

Settings and the blocked-profile count remain on your device until you change them, remove the extension, or clear the extension’s data in Chrome.

To delete them, remove Aufwieder-zen from `chrome://extensions`. Removing the extension deletes its local storage, including the settings and the count. Page content that was only held in memory is discarded when the LinkedIn tab or the temporary profile window closes.

People you blocked through LinkedIn remain on LinkedIn’s blocked list until you change that list in LinkedIn. The popup link “View Blocked Profiles” opens LinkedIn’s own page for that list.

## Limited Use

Use of information from LinkedIn pages complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#user_data), including the Limited Use requirements:

- The data is used only to provide and maintain the feed controls described in the Chrome Web Store listing and in the extension popup.
- It is not transferred to others, except as the policy allows for legal, security, or business-transfer reasons. This extension does not transfer it at all in ordinary use.
- It is not used or transferred for personalized, re-targeted, or interest-based advertising.
- The developer does not read your LinkedIn content. There is no server where a person could review it.

## Changes to This Policy

If the extension’s data practices change, this policy will be updated and the “Last updated” date above will change. The new policy will be posted at the same public address linked from the Chrome Web Store listing. Continued use of the extension after that date means the updated policy applies to the updated extension.

## Contact

Privacy questions: hello[@]charlesbail.fr
