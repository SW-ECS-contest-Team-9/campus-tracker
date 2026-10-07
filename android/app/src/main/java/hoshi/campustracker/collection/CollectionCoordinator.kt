package hoshi.campustracker.collection

import hoshi.campustracker.core.CollectorClock
import hoshi.campustracker.core.Iso
import hoshi.campustracker.core.L
import hoshi.campustracker.model.CollectionSession
import hoshi.campustracker.model.CollectionStatus
import hoshi.campustracker.model.CollectorAppState
import hoshi.campustracker.model.DeviceInfo
import hoshi.campustracker.model.EventMarkerType
import hoshi.campustracker.model.LocationCollectionProfile
import hoshi.campustracker.model.LocationFix
import hoshi.campustracker.model.MotionSamplingRate
import hoshi.campustracker.model.SampleCounts
import hoshi.campustracker.model.SensorCapabilities
import hoshi.campustracker.persistence.ActiveCollectionState
import hoshi.campustracker.persistence.ActiveCollectionStore
import hoshi.campustracker.persistence.CollectionDiagnostics
import hoshi.campustracker.persistence.SensorDataRepository
import hoshi.campustracker.sensors.AltimeterReading
import hoshi.campustracker.sensors.AltimeterSource
import hoshi.campustracker.sensors.AttitudeChoice
import hoshi.campustracker.sensors.KnownPosition
import hoshi.campustracker.sensors.LocationReading
import hoshi.campustracker.sensors.LocationSource
import hoshi.campustracker.sensors.MotionReading
import hoshi.campustracker.sensors.MotionSource
import hoshi.campustracker.sensors.PedometerSource
import hoshi.campustracker.sensors.StepReading
import hoshi.campustracker.sensors.StepRestore
import hoshi.campustracker.sync.AltimeterPayload
import hoshi.campustracker.sync.FinishPayload
import hoshi.campustracker.sync.LastSequences
import hoshi.campustracker.sync.LocationPayload
import hoshi.campustracker.sync.MarkerPayload
import hoshi.campustracker.sync.MotionPayload
import hoshi.campustracker.sync.PedometerPayload
import hoshi.campustracker.sync.SessionStartPayload
import hoshi.campustracker.sync.TelemetrySyncCoordinator
import hoshi.campustracker.sync.UploadOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.UUID

/** One serial execution context: sensor callbacks, sample creation, sequences, local writes (§4.0). */
interface SerialExecutor {
    fun post(block: () -> Unit)
    fun postDelayed(delayMs: Long, block: () -> Unit)
}

/** Android services the coordinator needs but cannot unit-test. */
interface CollectionPlatform {
    fun capabilities(attitude: AttitudeChoice?, motionHz: Int, locationProvider: String): SensorCapabilities
    fun locationAuthorizationLabel(): String
    fun isPowerSaveMode(): Boolean
    fun startForegroundCollection()
    fun stopForegroundCollection()
}

data class CollectorUiState(
    val activeSession: CollectionSession? = null,
    val interrupted: ActiveCollectionState? = null,
    val latestLocation: LocationPayload? = null,
    val latestRelativeAltitude: Double? = null,
    val latestStepCount: Long? = null,
    val counts: SampleCounts = SampleCounts(),
    val appState: CollectorAppState = CollectorAppState.FOREGROUND,
    val locationActive: Boolean = false,
    val motionActive: Boolean = false,
    val altimeterActive: Boolean = false,
    val pedometerActive: Boolean = false,
    val lastLocationMs: Long? = null,
    val lastMotionMs: Long? = null,
    val lastAltimeterMs: Long? = null,
    val lastPedometerMs: Long? = null,
    val lastPersistedMs: Long? = null,
    val diagnostics: CollectionDiagnostics? = null,
    val starting: Boolean = false,
    /** Publish time; makes every 0.5 s snapshot distinct so "last x.xs ago" stays current. */
    val publishedAtMs: Long = 0,
) {
    val backgroundCollectionEnabled: Boolean get() = activeSession != null && locationActive
}

/**
 * Collection side (iOS `CollectionCoordinator`, §5). Every public method posts onto [executor]; all mutable state
 * is confined to it. Upload is a separate concern ([sync]): nothing here waits for the server.
 */
class CollectionCoordinator(
    private val clock: CollectorClock,
    private val executor: SerialExecutor,
    private val location: LocationSource,
    private val motion: MotionSource,
    private val altimeter: AltimeterSource,
    private val pedometer: PedometerSource,
    private val repository: SensorDataRepository,
    private val activeStore: ActiveCollectionStore,
    private val sync: TelemetrySyncCoordinator,
    private val platform: CollectionPlatform,
    private val device: DeviceInfo,
    private val appState: () -> CollectorAppState,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    companion object {
        private const val TAG = "Collection"
        /** Resume skips ahead: the persisted sequences can lag the last uploaded ones by up to ~1 s (§12-8). */
        const val RESUME_SEQUENCE_GAP = 1_000L
        const val UI_REFRESH_MS = 500L
        const val PERSIST_INTERVAL_MS = 1_000L
    }

    private val _ui = MutableStateFlow(CollectorUiState())
    val ui: StateFlow<CollectorUiState> = _ui

    private var session: CollectionSession? = null
    private var runtime: ActiveCollectionState? = null
    private var interrupted: ActiveCollectionState? = null
    private var starting = false

    private var locationSequence = 0L
    private var motionSequence = 0L
    private var altimeterSequence = 0L
    private var pedometerSequence = 0L
    private var locationSegmentId = ""
    private var motionSegmentId = ""
    private var altimeterSegmentId = ""
    private var pedometerSegmentId = ""
    private var counts = SampleCounts()

    /** Last fix received by this process (markers, §5.4). */
    private var lastFix: LocationFix? = null
    private var latestLocation: LocationPayload? = null
    private var latestRelativeAltitude: Double? = null
    private var latestStepCount: Long? = null
    private var lastAppState = CollectorAppState.FOREGROUND
    private var appStateChangedMs = clock.nowMs()
    private var lastAuthorizationLabel: String? = null

    init {
        // A state file at process start means the process died while collecting (§5.5). Activity recreation never
        // reaches here because the coordinator is an Application-scoped singleton.
        activeStore.load()?.let { recovered ->
            val marked = recovered.copy(diagnostics = recovered.diagnostics.copy(wasInterrupted = true))
            interrupted = marked
            activeStore.save(marked)
            L.i(TAG, "INTERRUPTED_COLLECTION_FOUND session=${marked.session.id}")
        }
        publish()
        executor.postDelayed(UI_REFRESH_MS, ::tick)
    }

    // ---- public API ----

    fun startSession(
        collectorId: String,
        owner: UploadOwner,
        motionRate: MotionSamplingRate,
        locationProfile: LocationCollectionProfile,
        distanceFilter: Double,
    ) {
        val startedAt = clock.nowMs() // the moment Start was pressed; fixed for every re-send
        executor.post {
            if (session != null || starting) {
                L.w(TAG, "start ignored: a session is already active")
                return@post
            }
            starting = true
            publish()
            // The declination needs a recent position; wait briefly for it (never recorded as a sample).
            location.lastKnownPosition { position ->
                executor.post { beginSession(collectorId, owner, motionRate, locationProfile, distanceFilter, startedAt, position) }
            }
        }
    }

    fun stopSession() = executor.post {
        val current = session ?: return@post
        stopSensors("user_stop")
        val finished = current.copy(status = CollectionStatus.completed, endedAt = clock.nowMs(), sampleCounts = counts)
        sync.finish(
            FinishPayload(
                clientSessionId = finished.id,
                endedAt = Iso.format(finished.endedAt!!),
                lastSequences = lastSequences(counts, locationSequence, motionSequence, altimeterSequence, pedometerSequence),
            ),
        )
        L.i(TAG, "SESSION_FINISHED session=${finished.id} sequences=$locationSequence/$motionSequence/$altimeterSequence/$pedometerSequence")
        activeStore.clear()
        repository.update(finished)
        repository.flush()
        platform.stopForegroundCollection()
        session = null
        runtime = null
        publish()
    }

    fun addMarker(type: EventMarkerType) = executor.post {
        val current = session ?: return@post
        val fix = lastFix
        val marker = MarkerPayload(
            markerId = newId(), clientSessionId = current.id, timestamp = Iso.format(clock.nowMs()), type = type.wire,
            latitude = fix?.latitude, longitude = fix?.longitude, altitude = fix?.altitude, ellipsoidalAltitude = fix?.ellipsoidalAltitude,
            horizontalAccuracy = fix?.horizontalAccuracy, verticalAccuracy = fix?.verticalAccuracy,
        )
        repository.appendMarker(marker)
        sync.appendMarker(marker, needsLocation = fix == null)
        counts = counts.copy(marker = counts.marker + 1)
        trackCounts()
    }

    fun resumeInterrupted(owner: UploadOwner) = executor.post {
        val recovered = interrupted ?: return@post
        if (session != null || starting) return@post
        interrupted = null
        locationSequence = recovered.locationSequence + RESUME_SEQUENCE_GAP
        motionSequence = recovered.motionSequence + RESUME_SEQUENCE_GAP
        altimeterSequence = recovered.altimeterSequence + RESUME_SEQUENCE_GAP
        pedometerSequence = recovered.pedometerSequence + RESUME_SEQUENCE_GAP
        val resumed = recovered.session.copy(status = CollectionStatus.recording, endedAt = null)
        counts = resumed.sampleCounts
        session = resumed
        runtime = recovered.copy(
            session = resumed,
            locationSequence = locationSequence, motionSequence = motionSequence,
            altimeterSequence = altimeterSequence, pedometerSequence = pedometerSequence,
            diagnostics = recovered.diagnostics.copy(wasInterrupted = true),
        )
        resetLatest()
        repository.update(resumed)
        // Same clientSessionId and startedAt: the server returns the existing session (resumed: true).
        sync.start(startPayload(resumed), owner)
        val stepRestore = recovered.stepBaseline?.let { StepRestore(it, recovered.bootCount, recovered.lastStepTotal, recovered.lastPedometerTimestamp) }
        startSensors(resumed.sensorCapabilities, recovered.motionRate, recovered.locationProfile, recovered.distanceFilter, stepRestore)
        persist()
        platform.startForegroundCollection()
        L.i(TAG, "SESSION_RESUMED_WITH_GAP session=${resumed.id}")
        publish()
    }

    /** Closes the interrupted session locally and tells the server (`interrupted: true`, §12-7). */
    fun finishInterrupted(owner: UploadOwner) = executor.post {
        val recovered = interrupted ?: return@post
        val endedAt = recovered.lastSampleTimestamp ?: recovered.lastPersistedAt ?: clock.nowMs()
        val finished = recovered.session.copy(status = CollectionStatus.completed, endedAt = endedAt)
        repository.update(finished)
        sync.start(startPayload(finished), owner, active = false) // no-op when the queue already knows the session
        sync.finish(
            FinishPayload(
                clientSessionId = finished.id,
                endedAt = Iso.format(endedAt),
                lastSequences = lastSequences(
                    finished.sampleCounts, recovered.locationSequence, recovered.motionSequence, recovered.altimeterSequence, recovered.pedometerSequence,
                ),
                interrupted = true,
            ),
        )
        activeStore.clear()
        interrupted = null
        L.i(TAG, "SESSION_FINISHED_AS_INTERRUPTED session=${finished.id}")
        publish()
    }

    fun handleAppState(state: CollectorAppState) = executor.post {
        val now = clock.nowMs()
        val elapsed = now - appStateChangedMs
        runtime?.let { r ->
            var d = r.diagnostics
            d = when (lastAppState) {
                CollectorAppState.BACKGROUND -> d.copy(backgroundDurationMs = d.backgroundDurationMs + elapsed)
                CollectorAppState.FOREGROUND -> d.copy(foregroundDurationMs = d.foregroundDurationMs + elapsed)
                CollectorAppState.INACTIVE -> d
            }
            if (state == CollectorAppState.BACKGROUND && lastAppState != CollectorAppState.BACKGROUND) {
                d = d.copy(backgroundTransitionCount = d.backgroundTransitionCount + 1)
                diagnostic("APP_BACKGROUND")
            } else if (state == CollectorAppState.FOREGROUND && lastAppState != CollectorAppState.FOREGROUND) {
                diagnostic("APP_FOREGROUND")
            }
            d = d.copy(lowPowerModeObserved = d.lowPowerModeObserved || platform.isPowerSaveMode())
            runtime = r.copy(diagnostics = d)
            if (state == CollectorAppState.BACKGROUND) persist()
        }
        lastAppState = state
        appStateChangedMs = now
        // No pedometer re-query or extra sample on returning to the foreground (§5.6).
        if (state == CollectorAppState.FOREGROUND) checkLocationAuthorization()
        publish()
    }

    fun onPowerSaveModeChanged(enabled: Boolean) = executor.post {
        val r = runtime ?: return@post
        diagnostic("LOW_POWER_MODE", mapOf("enabled" to enabled.toString()))
        if (enabled) runtime = r.copy(diagnostics = r.diagnostics.copy(lowPowerModeObserved = true))
    }

    fun loadSessions(): List<CollectionSession> = repository.loadSessions()

    /** `session:start` ACK: remember the server session ID locally (metadata.json). */
    fun onServerSessionStarted(clientSessionId: String, serverSessionId: String) = executor.post {
        val current = session ?: return@post
        if (current.id != clientSessionId || current.serverSessionId == serverSessionId) return@post
        session = current.copy(serverSessionId = serverSessionId, sampleCounts = counts)
        runtime = runtime?.copy(session = session!!)
        repository.update(session!!)
        publish()
    }

    // ---- start / sensors ----

    private fun beginSession(
        collectorId: String,
        owner: UploadOwner,
        motionRate: MotionSamplingRate,
        profile: LocationCollectionProfile,
        distanceFilter: Double,
        startedAt: Long,
        position: KnownPosition?,
    ) {
        starting = false
        if (session != null) return
        val attitude = if (motion.isAvailable) motion.chooseAttitude(position, clock.nowMs()) else null
        val capabilities = platform.capabilities(attitude, motionRate.hz, location.providerLabel)
        lastAuthorizationLabel = capabilities.locationAuthorization
        val created = CollectionSession(
            id = newId(),
            collectorId = collectorId.ifEmpty { "Unassigned" },
            deviceId = device.deviceId,
            startedAt = startedAt,
            status = CollectionStatus.recording,
            deviceModel = device.deviceModel,
            systemVersion = device.systemVersion,
            sensorCapabilities = capabilities,
        )
        session = created
        counts = SampleCounts()
        locationSequence = 0; motionSequence = 0; altimeterSequence = 0; pedometerSequence = 0
        resetLatest()
        interrupted = null
        repository.create(created)
        runtime = ActiveCollectionState(
            session = created, motionRate = motionRate, locationProfile = profile, distanceFilter = distanceFilter,
            lastPersistedAt = clock.nowMs(),
            diagnostics = CollectionDiagnostics(lowPowerModeObserved = platform.isPowerSaveMode()),
        )
        persist()
        L.i(TAG, "SESSION_STARTED session=${created.id} frame=${capabilities.attitudeReferenceFrame} hz=${motionRate.hz}")
        sync.start(startPayload(created), owner)
        platform.startForegroundCollection()
        startSensors(capabilities, motionRate, profile, distanceFilter, stepRestore = null)
        publish()
    }

    private fun startSensors(
        capabilities: SensorCapabilities,
        motionRate: MotionSamplingRate,
        profile: LocationCollectionProfile,
        distanceFilter: Double,
        stepRestore: StepRestore?,
    ) {
        if (capabilities.locationAvailable) {
            locationSegmentId = newId()
            if (location.start(profile, distanceFilter, ::record)) {
                diagnostic("SENSOR_STARTED", mapOf("sensor" to "location", "sensorSegmentId" to locationSegmentId))
            } else {
                L.w(TAG, "location did not start (permission?)")
            }
        }
        if (capabilities.deviceMotionAvailable && motion.isAvailable) {
            // The frame and declination were fixed at session start and are reused on resume (§4.2).
            val attitude = AttitudeChoice(
                sensor = capabilities.attitudeSensor ?: AttitudeChoice.ROTATION_VECTOR,
                referenceFrame = capabilities.attitudeReferenceFrame ?: AttitudeChoice.MAGNETIC_NORTH,
                declinationDeg = capabilities.magneticDeclinationDeg,
            )
            motionSegmentId = newId()
            motion.start(
                hz = motionRate.hz,
                attitude = attitude,
                onReading = ::record,
                onRotationAccuracyChanged = { accuracy -> diagnostic("MAGNETIC_CALIBRATION", mapOf("accuracy" to accuracy.toString())) },
                onClockOffset = { offsetMs -> diagnostic("SENSOR_CLOCK_OFFSET", mapOf("offsetMs" to offsetMs.toString())) },
            )
            diagnostic("SENSOR_STARTED", mapOf("sensor" to "motion", "sensorSegmentId" to motionSegmentId, "referenceFrame" to attitude.referenceFrame))
        }
        if (capabilities.altimeterAvailable && altimeter.isAvailable) {
            altimeterSegmentId = newId()
            altimeter.start(::record)
            diagnostic("SENSOR_STARTED", mapOf("sensor" to "altimeter", "sensorSegmentId" to altimeterSegmentId))
        }
        if (capabilities.stepCountingAvailable) {
            pedometerSegmentId = newId()
            val started = pedometer.start(
                restore = stepRestore,
                onReading = ::record,
                onProgress = { baseline, total ->
                    runtime = runtime?.copy(stepBaseline = baseline, bootCount = pedometer.currentBootCount(), lastStepTotal = total)
                },
                onError = { code -> diagnostic("PEDOMETER_ERROR", mapOf("code" to code)) },
            )
            if (started) diagnostic("SENSOR_STARTED", mapOf("sensor" to "pedometer", "sensorSegmentId" to pedometerSegmentId))
        }
    }

    private fun stopSensors(reason: String) {
        if (location.isActive) {
            location.stop()
            diagnostic("SENSOR_STOPPED", mapOf("sensor" to "location", "sensorSegmentId" to locationSegmentId, "reason" to reason))
        }
        if (motion.isActive) {
            motion.stop()
            diagnostic("SENSOR_STOPPED", mapOf("sensor" to "motion", "sensorSegmentId" to motionSegmentId, "reason" to reason))
        }
        if (altimeter.isActive) {
            altimeter.stop()
            diagnostic("SENSOR_STOPPED", mapOf("sensor" to "altimeter", "sensorSegmentId" to altimeterSegmentId, "reason" to reason))
        }
        if (pedometer.isActive) {
            pedometer.stop()
            diagnostic("SENSOR_STOPPED", mapOf("sensor" to "pedometer", "sensorSegmentId" to pedometerSegmentId, "reason" to reason))
        }
    }

    // ---- samples ----

    private fun record(reading: LocationReading) {
        val current = session ?: return
        locationSequence += 1
        val sample = LocationPayload(
            sequence = locationSequence, timestamp = Iso.format(reading.timestampMs),
            latitude = reading.latitude, longitude = reading.longitude, altitude = reading.altitude, ellipsoidalAltitude = reading.ellipsoidalAltitude,
            horizontalAccuracy = reading.horizontalAccuracy, verticalAccuracy = reading.verticalAccuracy,
            speed = reading.speed, course = reading.course, speedAccuracy = reading.speedAccuracy, courseAccuracy = reading.courseAccuracy,
            appState = appState().wire, sensorSegmentId = locationSegmentId,
        )
        repository.appendLocation(sample)
        sync.appendLocation(sample)
        counts = counts.copy(location = counts.location + 1)
        latestLocation = sample
        val fix = LocationFix(reading.latitude, reading.longitude, reading.altitude, reading.ellipsoidalAltitude, reading.horizontalAccuracy, reading.verticalAccuracy)
        if (lastFix == null) sync.fillMarkerLocations(current.id, fix) // first fix of this process (§12-5)
        lastFix = fix
        runtime = runtime?.let {
            it.copy(
                locationSequence = locationSequence, lastLocationTimestamp = reading.timestampMs,
                diagnostics = it.diagnostics.copy(locationGaps = it.diagnostics.locationGaps.record(it.lastLocationTimestamp, reading.timestampMs, 1_000)),
            )
        }
        persistIfDue()
    }

    private fun record(reading: MotionReading) {
        session ?: return
        motionSequence += 1
        val timestampMs = motion.epochMs(reading.timestampNanos)
        val sample = MotionPayload(
            sequence = motionSequence, timestamp = Iso.format(timestampMs),
            userAcceleration = reading.userAcceleration, rotationRate = reading.rotationRate, gravity = reading.gravity, attitude = reading.attitude,
            appState = appState().wire, sensorSegmentId = motionSegmentId,
        )
        repository.appendMotion(sample)
        sync.appendMotion(sample)
        counts = counts.copy(motion = counts.motion + 1)
        runtime = runtime?.let {
            it.copy(
                motionSequence = motionSequence, lastMotionTimestamp = timestampMs,
                diagnostics = it.diagnostics.copy(motionGaps = it.diagnostics.motionGaps.record(it.lastMotionTimestamp, timestampMs, 1_000L / it.motionRate.hz)),
            )
        }
        persistIfDue()
    }

    private fun record(reading: AltimeterReading) {
        session ?: return
        altimeterSequence += 1
        val timestampMs = altimeter.epochMs(reading.timestampNanos)
        val sample = AltimeterPayload(
            sequence = altimeterSequence, timestamp = Iso.format(timestampMs),
            relativeAltitude = reading.relativeAltitude, pressure = reading.pressureKpa,
            appState = appState().wire, sensorSegmentId = altimeterSegmentId,
        )
        repository.appendAltimeter(sample)
        sync.appendAltimeter(sample)
        counts = counts.copy(altimeter = counts.altimeter + 1)
        latestRelativeAltitude = reading.relativeAltitude
        runtime = runtime?.let {
            it.copy(
                altimeterSequence = altimeterSequence, lastAltimeterTimestamp = timestampMs,
                diagnostics = it.diagnostics.copy(altimeterGaps = it.diagnostics.altimeterGaps.record(it.lastAltimeterTimestamp, timestampMs, 1_000)),
            )
        }
        persistIfDue()
    }

    private fun record(reading: StepReading) {
        session ?: return
        pedometerSequence += 1
        val sample = PedometerPayload(
            sequence = pedometerSequence, timestamp = Iso.format(reading.timestampMs), captureSource = reading.captureSource,
            numberOfSteps = reading.steps, appState = appState().wire, sensorSegmentId = pedometerSegmentId,
        )
        repository.appendPedometer(sample)
        sync.appendPedometer(sample)
        counts = counts.copy(pedometer = counts.pedometer + 1)
        latestStepCount = reading.steps
        runtime = runtime?.let {
            it.copy(
                pedometerSequence = pedometerSequence, lastPedometerTimestamp = reading.timestampMs, lastStepTotal = reading.steps,
                diagnostics = it.diagnostics.copy(pedometerGaps = it.diagnostics.pedometerGaps.record(it.lastPedometerTimestamp, reading.timestampMs, 5_000)),
            )
        }
        persistIfDue()
    }

    // ---- persistence / diagnostics / UI ----

    private fun persistIfDue() {
        val r = runtime ?: return
        val last = r.lastPersistedAt ?: 0L
        if (clock.nowMs() - last >= PERSIST_INTERVAL_MS) persist()
    }

    private fun persist() {
        val r = runtime ?: return
        val current = session ?: return
        val withCounts = current.copy(sampleCounts = counts)
        session = withCounts
        val updated = r.copy(
            session = withCounts, lastPersistedAt = clock.nowMs(),
            diagnostics = r.diagnostics.copy(pendingUploadPeakCount = maxOf(r.diagnostics.pendingUploadPeakCount, sync.status.value.pending)),
        )
        runtime = updated
        activeStore.save(updated)
    }

    private fun diagnostic(type: String, metadata: Map<String, String> = emptyMap()) {
        val current = session ?: return // only while a session is active (§10)
        sync.logDiagnostic(current.id, type, metadata, clock.nowMs())
    }

    private fun checkLocationAuthorization() {
        val label = platform.locationAuthorizationLabel()
        val previous = lastAuthorizationLabel
        lastAuthorizationLabel = label
        if (previous != null && previous != label) diagnostic("LOCATION_AUTHORIZATION_CHANGED", mapOf("status" to label))
    }

    private fun trackCounts() {
        session?.let { repository.track(it.copy(sampleCounts = counts)) }
    }

    private fun resetLatest() {
        latestLocation = null
        latestRelativeAltitude = null
        latestStepCount = null
    }

    private fun startPayload(s: CollectionSession) = SessionStartPayload(
        clientSessionId = s.id, deviceId = s.deviceId, deviceModel = s.deviceModel, systemVersion = s.systemVersion,
        appVersion = device.appVersion, sensorCapabilities = s.sensorCapabilities, startedAt = Iso.format(s.startedAt),
    )

    private fun tick() {
        trackCounts()
        repository.flushIfDue(clock.nowMs())
        sync.updateCounts(counts)
        publish()
        executor.postDelayed(UI_REFRESH_MS, ::tick)
    }

    private fun publish() {
        val r = runtime
        _ui.value = CollectorUiState(
            activeSession = session, interrupted = interrupted, latestLocation = latestLocation,
            latestRelativeAltitude = latestRelativeAltitude, latestStepCount = latestStepCount, counts = counts,
            appState = appState(), locationActive = location.isActive, motionActive = motion.isActive,
            altimeterActive = altimeter.isActive, pedometerActive = pedometer.isActive,
            lastLocationMs = r?.lastLocationTimestamp, lastMotionMs = r?.lastMotionTimestamp,
            lastAltimeterMs = r?.lastAltimeterTimestamp, lastPedometerMs = r?.lastPedometerTimestamp,
            lastPersistedMs = r?.lastPersistedAt, diagnostics = r?.diagnostics, starting = starting,
            publishedAtMs = clock.nowMs(),
        )
    }
}

/** `lastSequences`: the last sequence per stream, −1 for a stream with no samples (§12-9). */
fun lastSequences(counts: SampleCounts, location: Long, motion: Long, altimeter: Long, pedometer: Long) = LastSequences(
    location = if (counts.location == 0) -1 else location,
    motion = if (counts.motion == 0) -1 else motion,
    altimeter = if (counts.altimeter == 0) -1 else altimeter,
    pedometer = if (counts.pedometer == 0) -1 else pedometer,
)
