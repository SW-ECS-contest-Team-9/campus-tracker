import SwiftUI

/// Collection anchor for one marker (server `markers/marker-anchor.ts`). Start, End and Entrance ask
/// building → floor → node; stairs direction and floors; elevators the floors; ramps the direction.
/// The confirm button stays disabled until `AnchorRules.isComplete`.
struct AnchorPickerView: View {
    let type: EventMarkerType
    let configuration: ServerConfiguration?
    let location: (latitude: Double, longitude: Double)?
    let onConfirm: (CollectionAnchor) -> Void
    let onCancel: () -> Void

    @State private var anchor: CollectionAnchor
    @State private var buildings: [AnchorBuilding]?
    @State private var nodes: [AnchorNode]?
    @State private var loading = false
    @State private var error: String?

    init(type: EventMarkerType, initial: CollectionAnchor?, configuration: ServerConfiguration?,
         location: (latitude: Double, longitude: Double)?,
         onConfirm: @escaping (CollectionAnchor) -> Void, onCancel: @escaping () -> Void) {
        self.type = type
        self.configuration = configuration
        self.location = location
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        _anchor = State(initialValue: Self.prefill(type, initial))
    }

    private var needs: AnchorNeeds { AnchorRules.needs(type) }
    /// a floor without indoor nodes (nothing in the list) takes building + floor only
    private var complete: Bool {
        AnchorRules.isComplete(type, anchor, nodesOnOffer: !(nodes?.isEmpty ?? false)) && (needs != .place || nodes != nil)
    }

    var body: some View {
        NavigationView {
            Form {
                switch needs {
                case .place: placeSection
                case .stairs:
                    directionSection
                    floorPair
                case .elevator: floorPair
                case .ramp: directionSection
                case .none: EmptyView()
                }
                if let error {
                    Section {
                        Text(error).foregroundColor(.red)
                        Button("Retry") { self.error = nil; Task { await loadBuildings(); await loadNodes() } }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) { Button(confirmTitle) { onConfirm(anchor) }.disabled(!complete) }
            }
            .task { if needs == .place { await loadBuildings(); await loadNodes() } }
            .onChange(of: anchor.buildingId) { _ in Task { await loadNodes() } }
            .onChange(of: anchor.floor) { _ in Task { await loadNodes() } }
        }
    }

    @ViewBuilder private var placeSection: some View {
        Section("Building") {
            Picker("Building", selection: Binding(get: { anchor.buildingId ?? "" }, set: { value in
                anchor.buildingId = value.isEmpty ? nil : value
                if value == CollectionAnchor.outdoor { anchor.floor = nil }
                anchor.nodeId = nil; anchor.nodeLabel = nil
            })) {
                Text("Choose").tag("")
                ForEach(buildings ?? []) { b in Text(b.buildingName).tag(b.buildingId) }
            }
            if anchor.buildingId != nil && anchor.buildingId != CollectionAnchor.outdoor {
                let withNodes = Set(buildings?.first { $0.buildingId == anchor.buildingId }?.floorsWithNodes ?? [])
                Picker("Floor", selection: Binding(get: { anchor.floor ?? "" }, set: { value in
                    anchor.floor = value.isEmpty ? nil : value
                    anchor.nodeId = nil; anchor.nodeLabel = nil
                })) {
                    Text("Choose").tag("")
                    ForEach(AnchorRules.floors, id: \.self) { f in Text(withNodes.contains(f) ? "\(f) · nodes" : f).tag(f) }
                }
            }
        }
        if loading { ProgressView() }
        if let nodes {
            Section("Node (nearest first)") {
                if nodes.isEmpty {
                    Text("No mapped node on this floor: building and floor only.").font(.caption)
                }
                ForEach(nodes) { n in
                    Button {
                        anchor.nodeId = n.nodeId; anchor.nodeLabel = n.label
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(n.label)
                                Text([n.floor ?? "floor unknown", n.distanceM.map { String(format: "%.0f m", $0) }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundColor(.secondary)
                            }
                            Spacer()
                            if anchor.nodeId == n.nodeId { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
        }
    }

    private var directionSection: some View {
        Section("Direction") {
            Picker("Direction", selection: Binding(get: { anchor.direction ?? "" }, set: { anchor.direction = $0.isEmpty ? nil : $0 })) {
                Text("Up").tag("up")
                Text("Down").tag("down")
            }
            .pickerStyle(.segmented)
        }
    }

    private var floorPair: some View {
        Section("Floors") {
            Picker("From floor", selection: floorBinding(\.fromFloor)) {
                Text("Choose").tag("")
                ForEach(AnchorRules.floors, id: \.self) { Text($0).tag($0) }
            }
            Picker("To floor", selection: floorBinding(\.toFloor)) {
                Text("Choose").tag("")
                ForEach(AnchorRules.floors, id: \.self) { Text($0).tag($0) }
            }
        }
    }

    private func floorBinding(_ key: WritableKeyPath<CollectionAnchor, String?>) -> Binding<String> {
        Binding(get: { anchor[keyPath: key] ?? "" }, set: { value in
            anchor[keyPath: key] = value.isEmpty ? nil : value
            if needs == .stairs, let implied = AnchorRules.direction(from: anchor.fromFloor, to: anchor.toFloor) { anchor.direction = implied }
        })
    }

    private func loadBuildings() async {
        guard buildings == nil, let configuration else { if configuration == nil { error = "No server configured." }; return }
        do {
            buildings = try await AnchorNodeAPI.fetch(configuration: configuration, buildingId: nil, floor: nil,
                                                       latitude: location?.latitude, longitude: location?.longitude).buildings
        } catch let failure {
            error = failure.localizedDescription
        }
    }

    private func loadNodes() async {
        nodes = nil
        guard let configuration, let building = anchor.buildingId else { return }
        let outdoor = building == CollectionAnchor.outdoor
        if !outdoor && anchor.floor == nil { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await AnchorNodeAPI.fetch(configuration: configuration, buildingId: building, floor: outdoor ? nil : anchor.floor,
                                                         latitude: location?.latitude, longitude: location?.longitude)
            // a later choice may have replaced this one meanwhile
            if anchor.buildingId == building { nodes = response.nodes }
        } catch let failure {
            error = failure.localizedDescription
        }
    }

    private var title: String {
        switch type {
        case .sessionStart: return "Where are you starting?"
        case .sessionEnd: return "Where are you ending?"
        default: return type.title
        }
    }

    private var confirmTitle: String {
        switch type {
        case .sessionStart: return "Start"
        case .sessionEnd: return "Stop"
        default: return "Mark"
        }
    }

    /// Start/End/Entrance begin from the current place; an end marker repeats its open start's floors.
    private static func prefill(_ type: EventMarkerType, _ initial: CollectionAnchor?) -> CollectionAnchor {
        switch AnchorRules.needs(type) {
        case .place: return CollectionAnchor(buildingId: initial?.buildingId, floor: initial?.floor)
        case .stairs, .elevator:
            return CollectionAnchor(direction: initial?.direction, fromFloor: initial?.fromFloor ?? initial?.floor, toFloor: initial?.toFloor)
        case .ramp: return CollectionAnchor(direction: initial?.direction)
        case .none: return CollectionAnchor()
        }
    }
}
