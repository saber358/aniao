package com.aniao.backend.feedback;

import java.sql.DatabaseMetaData;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.DependsOn;
import org.springframework.stereotype.Component;

@Component
@DependsOn("entityManagerFactory")
public class FeedbackSchemaMigration implements ApplicationRunner {
	private static final Logger logger = LoggerFactory.getLogger(FeedbackSchemaMigration.class);
	private final DataSource dataSource;

	public FeedbackSchemaMigration(DataSource dataSource) {
		this.dataSource = dataSource;
	}

	/*
	 * ========================================================================
	 * 步骤1：允许旧 H2 数据库保存匿名反馈
	 * ========================================================================
	 * 目标表：feedback；数据源：现有数据库元数据。
	 * 操作：1) 只取消 user_id 非空限制；2) 保留历史数据与外键，重复启动可跳过。
	 */
	@Override
	public void run(ApplicationArguments arguments) throws Exception {
		logger.info("开始检查匿名反馈数据库约束");
		try (var connection = dataSource.getConnection()) {
			// 1.1 Hibernate update 不保证移除旧非空约束，按实际元数据补迁移。
			try (var columns = connection.getMetaData().getColumns(null, connection.getSchema(), "FEEDBACK", "USER_ID")) {
				if (!columns.next()) throw new IllegalStateException("feedback.user_id 列不存在");
				if (columns.getInt("NULLABLE") == DatabaseMetaData.columnNoNulls) {
					try (var statement = connection.createStatement()) {
						statement.execute("ALTER TABLE feedback ALTER COLUMN user_id DROP NOT NULL");
					}
				}
			}
		} finally {
			logger.info("匿名反馈数据库约束检查结束");
		}
	}
}
