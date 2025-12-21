# Changelog

## 1.2.2
- **New Feature**: Dynamic Scene Switch Management
  - Automatically create HomeKit switch buttons for each device's available scenes
  - Scene switches named after scene names with momentary switch behavior
  - Automatically add/remove corresponding switch buttons when scenes change
  - Execute corresponding scenes when switches are pressed, with error handling and status feedback
  - Synchronize scene switches when HomeData is updated
- **Improvement**: Refactored scene API methods, separated scene fetching and device filtering functionality
- **Fix**: Resolved recursive call issue in scene methods

## 1.0.15
- Fix Roborock Saros 10R Status issue

## 1.0.6
- Support new model

## 1.0.0

- First version.
