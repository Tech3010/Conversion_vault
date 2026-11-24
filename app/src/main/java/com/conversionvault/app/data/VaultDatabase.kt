package com.conversionvault.app.data

import android.content.Context
import androidx.room.*

@Entity(tableName = "jobs")
data class JobEntity(
    @PrimaryKey val id: String,
    val module: String,          // Vault_Core, Metadata_Modifier, Target_Compressor, Audio_Extract_Mute, Trim_GIF, Thumbnail_Capturer, Integrity_Check
    val mediaType: String,       // Video, Audio, Image, Mixed
    val inputPath: String,
    val outputPath: String,
    val commandArgs: String,     // FFmpeg argument string
    val status: String,          // QUEUED, RUNNING, DONE, CANCELLED, FAILED
    val progressPct: Int = 0,
    val fps: Float = 0f,
    val speed: String = "",
    val durationMs: Long = 0L,
    val originalPolicy: String = "KEEP", // KEEP, DELETE_AFTER_VERIFY
    val errorLog: String = "",
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "presets")
data class PresetEntity(
    @PrimaryKey val id: String,
    val name: String,
    val category: String,        // Video, Audio, Image
    val codec: String,
    val container: String,
    val crfOrBitrate: String,
    val extraFlags: String,
    val isBuiltIn: Boolean = false,
    val isDeleted: Boolean = false,
    val deletedAt: Long? = null,
    val updatedAt: Long = System.currentTimeMillis()
)

@Dao
interface JobDao {
    @Query("SELECT * FROM jobs ORDER BY createdAt DESC")
    suspend fun getAllJobs(): List<JobEntity>

    @Query("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY createdAt ASC LIMIT 1")
    suspend fun getNextQueuedJob(): JobEntity?

    @Query("SELECT * FROM jobs WHERE id = :id LIMIT 1")
    suspend fun getJobById(id: String): JobEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertJob(job: JobEntity)

    @Query("DELETE FROM jobs WHERE id = :id")
    suspend fun deleteJob(id: String)

    @Query("DELETE FROM jobs WHERE status IN ('DONE', 'CANCELLED', 'FAILED')")
    suspend fun clearFinishedHistory()
}

@Dao
interface PresetDao {
    @Query("SELECT * FROM presets WHERE isDeleted = 0 ORDER BY isBuiltIn DESC, updatedAt DESC")
    suspend fun getActivePresets(): List<PresetEntity>

    @Query("SELECT * FROM presets WHERE isDeleted = 1 ORDER BY deletedAt DESC")
    suspend fun getDeletedPresets(): List<PresetEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPreset(preset: PresetEntity)

    @Query("UPDATE presets SET isDeleted = 1, deletedAt = :now WHERE id = :id")
    suspend fun softDeletePreset(id: String, now: Long = System.currentTimeMillis())

    @Query("UPDATE presets SET isDeleted = 0, deletedAt = NULL WHERE id = :id")
    suspend fun restorePreset(id: String)

    @Query("DELETE FROM presets WHERE id = :id")
    suspend fun permanentlyDeletePreset(id: String)
}

@Database(entities = [JobEntity::class, PresetEntity::class], version = 1, exportSchema = false)
abstract class VaultDatabase : RoomDatabase() {
    abstract fun jobDao(): JobDao
    abstract fun presetDao(): PresetDao

    companion object {
        @Volatile
        private var INSTANCE: VaultDatabase? = null

        fun getInstance(context: Context): VaultDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    VaultDatabase::class.java,
                    "conversion_vault.db"
                ).build().also { INSTANCE = it }
            }
        }
    }
}
