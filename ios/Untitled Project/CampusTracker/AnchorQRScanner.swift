import SwiftUI
import AVFoundation
import UIKit

/// The QR contains only a map node identifier. Coordinates are always resolved from the configured server.
struct AnchorQRScanner: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = false

    var body: some View {
        NavigationView {
            Group {
                if denied {
                    Text("Camera access is unavailable. Enable it in Settings or choose a node manually.")
                        .padding()
                } else {
                    AnchorCameraView(onScan: onScan, onUnavailable: { denied = true })
                        .ignoresSafeArea(edges: .bottom)
                }
            }
            .navigationTitle("Scan anchor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct AnchorCameraView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onUnavailable: () -> Void
    func makeUIViewController(context: Context) -> AnchorCameraController {
        AnchorCameraController(onScan: onScan, onUnavailable: onUnavailable)
    }
    func updateUIViewController(_ controller: AnchorCameraController, context: Context) {}
    static func dismantleUIViewController(_ controller: AnchorCameraController, coordinator: ()) { controller.stop() }
}

private final class AnchorCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let onScan: (String) -> Void
    private let onUnavailable: () -> Void
    private var delivered = false
    private var preview: AVCaptureVideoPreviewLayer?

    init(onScan: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
        self.onScan = onScan
        self.onUnavailable = onUnavailable
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard allowed, let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(input) else {
                    self.onUnavailable(); return
                }
                self.session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard self.session.canAddOutput(output) else { self.onUnavailable(); return }
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
                let preview = AVCaptureVideoPreviewLayer(session: self.session)
                preview.videoGravity = .resizeAspectFill
                self.view.layer.addSublayer(preview)
                self.preview = preview
                self.view.setNeedsLayout()
                DispatchQueue.global(qos: .userInitiated).async { [session = self.session] in session.startRunning() }
            }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func stop() { DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        delivered = true
        onScan(value)
    }
}
