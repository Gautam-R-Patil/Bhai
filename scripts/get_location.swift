#!/usr/bin/env swift
// Get device location using macOS CoreLocation — Bhai
// Usage: get_location_bin
// Outputs: latitude|longitude|altitude|accuracy
// Or: error|<reason>
// Requires Location Services enabled in System Settings > Privacy & Security > Location Services
// On first run, macOS will show a permission dialog (requires Info.plist embedding).

import Foundation
import CoreLocation

class LocationFetcher: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    var done = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func start() {
        guard CLLocationManager.locationServicesEnabled() else {
            print("error|location_services_disabled")
            done = true
            return
        }

        let status = manager.authorizationStatus
        switch status {
        case .notDetermined:
            // This triggers the macOS permission dialog
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            print("error|permission_denied")
            done = true
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        @unknown default:
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !done else { return }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            print("error|permission_denied")
            done = true
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            break // Still waiting for user
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !done, let loc = locations.last, loc.horizontalAccuracy >= 0 else { return }
        print("\(loc.coordinate.latitude)|\(loc.coordinate.longitude)|\(loc.altitude)|\(loc.horizontalAccuracy)")
        done = true
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard !done else { return }
        if let clErr = error as? CLError, clErr.code == .denied {
            print("error|permission_denied")
        } else {
            print("error|\(error.localizedDescription)")
        }
        done = true
    }
}

let fetcher = LocationFetcher()
fetcher.start()

// Run the main run loop — needed for CoreLocation callbacks and permission dialog
let deadline = Date(timeIntervalSinceNow: 10)
while !fetcher.done && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
}

if !fetcher.done {
    print("error|timeout")
}
